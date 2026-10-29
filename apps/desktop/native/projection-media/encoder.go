package projection

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
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
	input   io.WriteCloser
	packets *net.UDPConn
	cancel  context.CancelFunc
	length  int
	done    chan struct{}
	closed  chan struct{}
	reader  chan struct{}
	once    sync.Once
	write   sync.Mutex
	err     error
}

func StartEncoder(ctx context.Context, config EncoderConfig, output RTPWriter) (*Encoder, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(config.Executable) || output == nil || config.Width < 2 || config.Height < 2 || config.Width > 4096 || config.Height > 4096 || config.Width%2 != 0 || config.Height%2 != 0 || config.FPS < 1 || config.FPS > 60 || config.Bitrate < 64_000 || config.Bitrate > 40_000_000 {
		return nil, errors.New("invalid projection encoder configuration")
	}
	packets, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, err
	}
	if err = packets.SetReadBuffer(256 * 1024); err != nil {
		_ = packets.Close()
		return nil, err
	}
	run, cancel := context.WithCancel(context.Background())
	address := packets.LocalAddr().(*net.UDPAddr)
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-f", "rawvideo", "-pixel_format", "bgra", "-video_size", fmt.Sprintf("%dx%d", config.Width, config.Height),
		"-framerate", strconv.Itoa(config.FPS), "-i", "pipe:0", "-an",
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
		"-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level:v", "3.1",
		"-b:v", strconv.Itoa(config.Bitrate), "-maxrate", strconv.Itoa(config.Bitrate), "-bufsize", strconv.Itoa(config.Bitrate),
		"-bf", "0", "-g", strconv.Itoa(config.FPS), "-keyint_min", strconv.Itoa(config.FPS),
		"-x264-params", "repeat-headers=1:scenecut=0", "-fps_mode", "passthrough",
		"-f", "rtp", "-payload_type", "96", "-rtpflags", "skip_rtcp",
		fmt.Sprintf("rtp://127.0.0.1:%d?pkt_size=1200", address.Port),
	}
	cmd := exec.CommandContext(run, config.Executable, args...)
	diagnostics := &encoderLog{}
	cmd.Stderr = diagnostics
	cmd.Stdout = io.Discard
	input, err := cmd.StdinPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		cancel()
		_ = packets.Close()
		if input != nil {
			_ = input.Close()
		}
		return nil, err
	}
	e := &Encoder{input: input, packets: packets, cancel: cancel, length: config.Width * config.Height * 4, done: make(chan struct{}), closed: make(chan struct{}), reader: make(chan struct{})}
	stopParent := context.AfterFunc(ctx, func() { e.stop(ctx.Err()) })
	go func() {
		defer close(e.reader)
		packet := make([]byte, 1501)
		for {
			n, from, readErr := packets.ReadFromUDP(packet)
			if readErr != nil {
				select {
				case <-e.done:
				default:
					e.stop(readErr)
				}
				return
			}
			if !from.IP.IsLoopback() || n > 1500 {
				e.stop(errors.New("invalid encoder RTP packet"))
				return
			}
			if sendErr := output.RTP(packet[:n]); sendErr != nil {
				e.stop(sendErr)
				return
			}
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
		_ = e.packets.Close()
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
		if e.err != nil {
			return fmt.Errorf("%w: %v", ErrClosed, e.err)
		}
		return ErrClosed
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
