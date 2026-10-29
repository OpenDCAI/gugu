package projection

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

// EncoderConfig comes from the host. Executable is its resolved FFmpeg binary,
// never an executable name, command, URL or path supplied by an App.
type EncoderConfig struct {
	Executable string
	Width      int
	Height     int
	FPS        int
	Bitrate    int
}

var ErrEncoderBusy = errors.New("projection encoder already has an input frame")

type RTPWriter interface {
	RTP([]byte) error
}

// Encoder accepts tightly packed BGRA frames and sends encoded H.264 RTP to the
// host transport. A write is encoder admission, not a viewer paint acknowledgement.
// Size changes require a new encoder and a new host input generation.
type Encoder struct {
	input  io.WriteCloser
	output io.ReadCloser
	cancel context.CancelFunc
	length int
	done   chan struct{}
	closed chan struct{}
	reader chan struct{}
	once   sync.Once
	write  sync.Mutex
	err    error
}

func validEncoderConfig(config EncoderConfig) bool {
	if !filepath.IsAbs(config.Executable) || config.Width < 2 || config.Height < 2 || config.Width > 2560 || config.Height > 2560 || config.Width%2 != 0 || config.Height%2 != 0 || config.FPS < 1 || config.FPS > 60 || config.Bitrate < 64_000 || config.Bitrate > 14_000_000 {
		return false
	}
	// Match the advertised baseline level 3.1: ITU-T H.264 Table A-1.
	// Round each dimension separately; a few extra pixels can require another MB.
	macroblocks := ((config.Width + 15) / 16) * ((config.Height + 15) / 16)
	return macroblocks <= 3600 && macroblocks*config.FPS <= 108000
}

func StartEncoder(ctx context.Context, config EncoderConfig, output RTPWriter) (*Encoder, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validEncoderConfig(config) || output == nil {
		return nil, errors.New("invalid projection encoder configuration")
	}
	var ssrc [4]byte
	if _, err := rand.Read(ssrc[:]); err != nil {
		return nil, err
	}
	run, cancel := context.WithCancel(context.Background())
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-f", "rawvideo", "-pixel_format", "bgra", "-video_size", fmt.Sprintf("%dx%d", config.Width, config.Height),
		"-framerate", strconv.Itoa(config.FPS), "-i", "pipe:0", "-an",
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
		// Convert RGB with the same matrix advertised in the H.264 SPS/VUI.
		// Unspecified defaults differ between FFmpeg and browser decoders.
		"-vf", "scale=out_color_matrix=bt709:out_range=tv,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
		"-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
		"-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level:v", "3.1",
		"-b:v", strconv.Itoa(config.Bitrate), "-maxrate", strconv.Itoa(config.Bitrate), "-bufsize", strconv.Itoa(config.Bitrate),
		"-bf", "0", "-g", strconv.Itoa(config.FPS), "-keyint_min", strconv.Itoa(config.FPS),
		"-x264-params", "repeat-headers=1:scenecut=0", "-fps_mode", "passthrough",
		"-f", "flv", "-flvflags", "no_duration_filesize", "-flush_packets", "1", "pipe:1",
	}
	cmd := exec.CommandContext(run, config.Executable, args...)
	cmd.WaitDelay = 2 * time.Second
	cmd.Env = []string{"LANG=C", "LC_ALL=C"}
	for _, name := range []string{"SystemRoot", "WINDIR"} {
		if value := os.Getenv(name); value != "" {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	diagnostics := &encoderLog{}
	cmd.Stderr = diagnostics
	input, err := cmd.StdinPipe()
	var encoded io.ReadCloser
	if err == nil {
		encoded, err = cmd.StdoutPipe()
	}
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		cancel()
		if encoded != nil {
			_ = encoded.Close()
		}
		if input != nil {
			_ = input.Close()
		}
		return nil, err
	}
	e := &Encoder{input: input, output: encoded, cancel: cancel, length: config.Width * config.Height * 4, done: make(chan struct{}), closed: make(chan struct{}), reader: make(chan struct{})}
	stopParent := context.AfterFunc(ctx, func() { e.stop(ctx.Err()) })
	go func() {
		defer close(e.reader)
		packetizer := rtp.NewPacketizer(1200, 96, binary.BigEndian.Uint32(ssrc[:]), &codecs.H264Payloader{}, rtp.NewRandomSequencer(), 90000)
		readErr := readEncodedFrames(encoded, func(annexB []byte) error {
			for _, packet := range packetizer.Packetize(annexB, uint32(90000/config.FPS)) {
				data, err := packet.Marshal()
				if err != nil {
					return err
				}
				if err = output.RTP(data); err != nil {
					return err
				}
			}
			return nil
		})
		select {
		case <-e.done:
		default:
			e.stop(readErr)
		}
	}()
	go func() {
		waitErr := cmd.Wait()
		stopParent()
		select {
		case <-e.done:
		default:
			if waitErr == nil {
				waitErr = errors.New("projection encoder exited unexpectedly")
			}
			e.stop(fmt.Errorf("projection encoder: %w: %s", waitErr, diagnostics.text()))
		}
		<-e.reader
		close(e.closed)
	}()
	return e, nil
}

func (e *Encoder) stop(err error) {
	e.once.Do(func() {
		e.err = err
		close(e.done)
		_ = e.input.Close()
		_ = e.output.Close()
		e.cancel()
	})
}

// WriteFrame does not queue frames. The host may retain one latest pending frame;
// a concurrent write is rejected before any bytes of that frame reach FFmpeg.
// Cancelling a started write stops this encoder: a partial raw frame is not retryable.
func (e *Encoder) WriteFrame(ctx context.Context, bgra []byte) error {
	if len(bgra) != e.length {
		return errors.New("projection frame does not match encoder dimensions")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !e.write.TryLock() {
		return ErrEncoderBusy
	}
	defer e.write.Unlock()
	select {
	case <-e.done:
		return e.closedError()
	default:
	}
	stopWrite := context.AfterFunc(ctx, func() { e.stop(ctx.Err()) })
	defer stopWrite()
	if _, err := e.input.Write(bgra); err != nil {
		e.stop(err)
		return err
	}
	return ctx.Err()
}

func (e *Encoder) closedError() error {
	if e.err != nil {
		return fmt.Errorf("%w: %v", ErrClosed, e.err)
	}
	return ErrClosed
}

func (e *Encoder) Close() error {
	e.stop(nil)
	<-e.closed
	return e.err
}

// Keep a bounded tail while draining all stderr, so diagnostics cannot grow
// without bound or block the encoder when the host is not consuming logs.
type encoderLog struct {
	mu   sync.Mutex
	tail []byte
}

func (l *encoderLog) Write(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.tail = append(l.tail, data...)
	if len(l.tail) > 4096 {
		l.tail = append([]byte(nil), l.tail[len(l.tail)-4096:]...)
	}
	return len(data), nil
}

func (l *encoderLog) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return string(l.tail)
}
