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
}

type encodingFrame struct {
	sequence  uint64
	timestamp uint32
	started   bool
	finished  chan EncodedFrame
}

// VideoEncoder allows one source frame in flight. New source frames cannot be
// associated with a prior frame merely because the sizes or pixels are equal.
// A geometry or target change requires a new host input generation.
type VideoEncoder struct {
	encoder *Encoder
	output  RTPWriter
	config  EncoderConfig
	write   sync.Mutex
	mu      sync.Mutex
	last    uint64
	pending *encodingFrame
}

func StartVideoEncoder(ctx context.Context, config EncoderConfig, output RTPWriter) (*VideoEncoder, error) {
	if output == nil {
		return nil, errors.New("video encoder needs an RTP destination")
	}
	v := &VideoEncoder{output: output, config: config}
	encoder, err := StartEncoder(ctx, config, v)
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
	parent := ctx
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	v.mu.Lock()
	if sequence <= v.last {
		v.mu.Unlock()
		return EncodedFrame{}, errors.New("source frame sequence must increase")
	}
	frame := &encodingFrame{sequence: sequence, finished: make(chan EncodedFrame, 1)}
	v.last, v.pending = sequence, frame
	v.mu.Unlock()
	if err := v.encoder.WriteFrame(ctx, bgra); err != nil {
		return EncodedFrame{}, err
	}
	select {
	case receipt := <-frame.finished:
		return receipt, nil
	case <-v.encoder.done:
		return EncodedFrame{}, v.encoder.closedError()
	case <-ctx.Done():
		// Its bytes may already be in the encoder. Never relabel a late packet as
		// a subsequent source frame or retry an uncertain frame on this stream.
		err := ctx.Err()
		if parent.Err() != nil {
			err = parent.Err()
		} else if errors.Is(err, context.DeadlineExceeded) {
			err = errors.New("projection frame encoding timed out")
		}
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

func (v *VideoEncoder) Close() error { return v.encoder.Close() }
