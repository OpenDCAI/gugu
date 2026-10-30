package projection

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/pion/rtp"
)

// EncodedFrame maps a host source sequence to the RTP timestamp of its video
// frame. It is an encoder receipt, not proof that a viewer displayed the frame.
// A viewer must acknowledge the RTP timestamp actually decoded by its video.
type EncodedFrame struct {
	Sequence  uint64 `json:"sequence"`
	Timestamp uint32 `json:"rtpTimestamp"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Recovery  bool   `json:"recovery,omitempty"`
}

type encodingFrame struct {
	sequence  uint64
	timestamp uint32
	started   bool
	finished  chan EncodedFrame
}

var errFrameEncodingTimeout = errors.New("projection frame encoding timed out")

// VideoEncoder allows one source frame in flight. New source frames cannot be
// associated with a prior frame merely because the sizes or pixels are equal.
// A geometry or target change requires a new host input generation.
type VideoEncoder struct {
	encoder    *Encoder
	output     RTPWriter
	config     EncoderConfig
	write      sync.Mutex
	mu         sync.Mutex
	last       uint64
	pending    *encodingFrame
	ctx        context.Context
	packetizer rtp.Packetizer
	pixels     []byte
	completed  uint64
	closed     bool
}

func StartVideoEncoder(ctx context.Context, config EncoderConfig, output RTPWriter) (*VideoEncoder, error) {
	if output == nil {
		return nil, errors.New("video encoder needs an RTP destination")
	}
	packetizer, err := newVideoPacketizer()
	if err != nil {
		return nil, err
	}
	if !validEncoderConfig(config) {
		return nil, errors.New("invalid projection encoder configuration")
	}
	v := &VideoEncoder{output: output, config: config, ctx: ctx, packetizer: packetizer, pixels: make([]byte, config.Width*config.Height*4)}
	encoder, err := startEncoder(ctx, config, v, packetizer)
	if err != nil {
		return nil, err
	}
	v.encoder = encoder
	return v, nil
}

func (v *VideoEncoder) WriteFrame(ctx context.Context, sequence uint64, bgra []byte) (EncodedFrame, error) {
	if sequence == 0 || sequence > 1<<53-1 || len(bgra) != v.config.Width*v.config.Height*4 {
		return EncodedFrame{}, errors.New("invalid source video frame")
	}
	if err := ctx.Err(); err != nil {
		return EncodedFrame{}, err
	}
	if !v.write.TryLock() {
		return EncodedFrame{}, ErrEncoderBusy
	}
	defer v.write.Unlock()
	if v.closed {
		return EncodedFrame{}, ErrClosed
	}
	if sequence <= v.last {
		return EncodedFrame{}, errors.New("source frame sequence must increase")
	}
	v.last = sequence
	receipt, err := v.encode(ctx, sequence, bgra)
	if err == nil {
		copy(v.pixels, bgra)
		v.completed = sequence
	}
	return receipt, err
}

// RefreshFrame resends only the last successfully encoded picture, never an
// uncertain write or an input operation. Its source identity stays unchanged;
// the receiver matches the new RTP timestamp before acknowledging that source.
// Callers coalesce/rate-limit receiver feedback before asking for this restart.
func (v *VideoEncoder) RefreshFrame(ctx context.Context) (EncodedFrame, error) {
	if !v.write.TryLock() {
		return EncodedFrame{}, ErrEncoderBusy
	}
	defer v.write.Unlock()
	if v.closed {
		return EncodedFrame{}, ErrClosed
	}
	if v.completed == 0 {
		return EncodedFrame{}, errors.New("no completed picture to refresh")
	}
	if err := ctx.Err(); err != nil {
		return EncodedFrame{}, err
	}
	if err := v.encoder.Close(); err != nil {
		return EncodedFrame{}, err
	}
	encoder, err := startEncoder(v.ctx, v.config, v, v.packetizer)
	if err != nil {
		return EncodedFrame{}, err
	}
	v.encoder = encoder
	receipt, err := v.encode(ctx, v.completed, v.pixels)
	receipt.Recovery = true
	return receipt, err
}

func (v *VideoEncoder) encode(ctx context.Context, sequence uint64, bgra []byte) (EncodedFrame, error) {
	ctx, cancel := context.WithTimeoutCause(ctx, 3*time.Second, errFrameEncodingTimeout)
	defer cancel()
	v.mu.Lock()
	frame := &encodingFrame{sequence: sequence, finished: make(chan EncodedFrame, 1)}
	v.pending = frame
	v.mu.Unlock()
	if err := v.encoder.WriteFrame(ctx, bgra); err != nil {
		return EncodedFrame{}, err
	}
	select {
	case receipt := <-frame.finished:
		return receipt, nil
	case <-v.encoder.done:
		if cause := context.Cause(ctx); cause != nil {
			return EncodedFrame{}, cause
		}
		return EncodedFrame{}, v.encoder.closedError()
	case <-ctx.Done():
		// Its bytes may already be in the encoder. Never relabel a late packet as
		// a subsequent source frame or retry an uncertain frame on this stream.
		err := context.Cause(ctx)
		v.encoder.stop(err)
		return EncodedFrame{}, err
	}
}

func (v *VideoEncoder) RTP(data []byte) error {
	packet := &rtp.Packet{}
	if err := packet.Unmarshal(data); err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	frame := v.pending
	if frame == nil {
		return errors.New("encoder emitted an unassociated video frame")
	}
	if frame.started && frame.timestamp != packet.Timestamp {
		return errors.New("encoder changed timestamp before completing a video frame")
	}
	frame.started, frame.timestamp = true, packet.Timestamp
	if err := v.output.RTP(data); err != nil {
		return err
	}
	if packet.Marker {
		v.pending = nil
		frame.finished <- EncodedFrame{Sequence: frame.sequence, Timestamp: frame.timestamp, Width: v.config.Width, Height: v.config.Height}
	}
	return nil
}

func (v *VideoEncoder) Close() error {
	v.write.Lock()
	defer v.write.Unlock()
	v.closed = true
	return v.encoder.Close()
}
