package projection

import (
	"bytes"
	"context"
	"errors"
	"math/rand/v2"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

func ffmpegExecutable(t *testing.T) string {
	t.Helper()
	if path := os.Getenv("GUGU_PROJECTION_FFMPEG"); path != "" {
		return path
	}
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("real media tests require FFmpeg; set GUGU_PROJECTION_FFMPEG to its absolute path")
	}
	return path
}

func testEncoderConfig(t *testing.T) EncoderConfig {
	return EncoderConfig{Executable: ffmpegExecutable(t), Width: 128, Height: 96, FPS: 10, Bitrate: 500_000}
}

func answerProjection(t *testing.T, ctx context.Context, source *Transport, viewer *webrtc.PeerConnection) {
	t.Helper()
	offer, err := source.Offer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = viewer.SetRemoteDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := viewer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(viewer)
	if err = viewer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err = source.Remote(*viewer.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	if err = source.Ready(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestEncodedFramesCrossSRTPAndDecodeInOrder(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	source, err := New(Config{Loopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	viewer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.Close()
	// The receiver accepts the ordered input channel as a real viewer does.
	// Pion's default handler deliberately closes unhandled channels.
	viewer.OnDataChannel(func(channel *webrtc.DataChannel) {
		channel.OnMessage(func(webrtc.DataChannelMessage) {})
	})
	encoded := make(chan []byte, 1)
	trackErrors := make(chan error, 1)
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		depacketizer := &codecs.H264Packet{}
		var annexB bytes.Buffer
		frames := 0
		for frames < 3 {
			packet, _, readErr := track.ReadRTP()
			if readErr != nil {
				trackErrors <- readErr
				return
			}
			nal, readErr := depacketizer.Unmarshal(packet.Payload)
			if readErr != nil {
				trackErrors <- readErr
				return
			}
			annexB.Write(nal)
			if packet.Marker {
				frames++
			}
		}
		encoded <- annexB.Bytes()
	})
	answerProjection(t, ctx, source, viewer)
	config := testEncoderConfig(t)
	encoder, err := StartEncoder(ctx, config, source)
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	for index := 0; index < 3; index++ {
		frame := make([]byte, config.Width*config.Height*4)
		for offset := 0; offset < len(frame); offset += 4 {
			frame[offset+index] = 230
			frame[offset+3] = 255
		}
		if err = encoder.WriteFrame(ctx, frame); err != nil {
			t.Fatal(err)
		}
	}
	var stream []byte
	select {
	case stream = <-encoded:
	case err = <-trackErrors:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	decoder := exec.CommandContext(ctx, config.Executable, "-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-frames:v", "3", "-f", "rawvideo", "-pix_fmt", "bgra", "pipe:1")
	decoder.Stdin = bytes.NewReader(stream)
	var diagnostics bytes.Buffer
	decoder.Stderr = &diagnostics
	decoded, err := decoder.Output()
	if err != nil {
		t.Fatalf("decode received video: %v: %s", err, &diagnostics)
	}
	length := config.Width * config.Height * 4
	if len(decoded) != 3*length {
		t.Fatalf("decoded %d bytes, expected three complete frames (%d)", len(decoded), 3*length)
	}
	for index := 0; index < 3; index++ {
		pixel := decoded[index*length+length/2 : index*length+length/2+4]
		for channel := 0; channel < 3; channel++ {
			want := 0
			if channel == index {
				want = 230
			}
			if delta := int(pixel[channel]) - want; delta < -8 || delta > 8 {
				t.Fatalf("frame %d decoded pixel %v, color/order differs", index, pixel)
			}
		}
	}
	if err = encoder.Close(); err != nil {
		t.Fatal(err)
	}
	if err = encoder.WriteFrame(ctx, make([]byte, length)); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed encoder admitted another frame: %v", err)
	}
}

type ignoreRTP struct{}

func (ignoreRTP) RTP([]byte) error { return nil }

func TestEncoderCancellationAndFrameBounds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	config := testEncoderConfig(t)
	encoder, err := StartEncoder(ctx, config, ignoreRTP{})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	defer encoder.Close()
	if err = encoder.WriteFrame(ctx, []byte{0}); err == nil {
		t.Fatal("wrong-sized frame was admitted")
	}
	frame := make([]byte, config.Width*config.Height*4)
	if err = encoder.WriteFrame(ctx, frame); err != nil {
		t.Fatal("invalid frame poisoned a later valid frame", err)
	}
	cancel()
	select {
	case <-encoder.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("encoder process/socket did not close after cancellation")
	}
	if err = encoder.WriteFrame(context.Background(), frame); !errors.Is(err, ErrClosed) {
		t.Fatalf("cancelled encoder admitted input: %v", err)
	}
}

func TestEncoderRejectsUntrustedExecutableAndInvalidGeometry(t *testing.T) {
	config := testEncoderConfig(t)
	config.Executable = "ffmpeg"
	if _, err := StartEncoder(context.Background(), config, ignoreRTP{}); err == nil {
		t.Fatal("relative executable admitted")
	}
	config = testEncoderConfig(t)
	config.Width = 127
	if _, err := StartEncoder(context.Background(), config, ignoreRTP{}); err == nil {
		t.Fatal("unaligned geometry admitted")
	}
	config = testEncoderConfig(t)
	config.Executable += ".missing"
	if _, err := StartEncoder(context.Background(), config, ignoreRTP{}); err == nil {
		t.Fatal("missing encoder reported success")
	}
}

func TestEncoderEnforcesTheAdvertisedH264Level(t *testing.T) {
	for name, mutate := range map[string]func(*EncoderConfig){
		"frame size":          func(c *EncoderConfig) { c.Width, c.Height = 1920, 1080 },
		"macroblock rate":     func(c *EncoderConfig) { c.Width, c.Height, c.FPS = 1280, 720, 60 },
		"rounded macroblocks": func(c *EncoderConfig) { c.Width, c.Height = 1282, 712 },
		"bitrate":             func(c *EncoderConfig) { c.Bitrate = 14_000_001 },
	} {
		t.Run(name, func(t *testing.T) {
			config := testEncoderConfig(t)
			mutate(&config)
			encoder, err := StartEncoder(context.Background(), config, ignoreRTP{})
			if encoder != nil {
				_ = encoder.Close()
			}
			if err == nil {
				t.Fatal("encoder admitted a configuration exceeding its advertised level 3.1")
			}
		})
	}
	config := testEncoderConfig(t)
	config.Width, config.Height, config.FPS, config.Bitrate = 1280, 720, 30, 14_000_000
	if !validEncoderConfig(config) {
		t.Fatal("level 3.1 boundary was rejected")
	}
	config.Width, config.Height = 720, 1280
	if !validEncoderConfig(config) {
		t.Fatal("portrait level 3.1 boundary was rejected")
	}
}

type capturedRTP struct {
	mu      sync.Mutex
	packets [][]byte
}

func (c *capturedRTP) RTP(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.packets = append(c.packets, bytes.Clone(data))
	return nil
}

func TestOwnedEncoderPipePacketizesLargeAccessUnits(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	config := testEncoderConfig(t)
	output := &capturedRTP{}
	video, err := StartVideoEncoder(ctx, config, output)
	if err != nil {
		t.Fatal(err)
	}
	defer video.Close()
	frame := make([]byte, config.Width*config.Height*4)
	random := rand.New(rand.NewPCG(11, 42))
	for index := range frame {
		frame[index] = byte(random.Uint32())
	}
	receipt, err := video.WriteFrame(ctx, 77, frame)
	if err != nil {
		t.Fatal(err)
	}
	output.mu.Lock()
	packets := append([][]byte(nil), output.packets...)
	output.mu.Unlock()
	depacketizer := &codecs.H264Packet{}
	var encoded bytes.Buffer
	markers, fragments := 0, 0
	for _, data := range packets {
		if len(data) > 1200 {
			t.Fatal("host packetizer exceeded its MTU")
		}
		packet := &rtp.Packet{}
		if err = packet.Unmarshal(data); err != nil {
			t.Fatal(err)
		}
		if packet.Timestamp != receipt.Timestamp {
			t.Fatal("one access unit used multiple timestamps")
		}
		if packet.Marker {
			markers++
		}
		if packet.Payload[0]&31 == 28 {
			fragments++
		}
		annexB, decodeErr := depacketizer.Unmarshal(packet.Payload)
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		encoded.Write(annexB)
	}
	if markers != 1 || fragments < 2 {
		t.Fatalf("expected one complete fragmented access unit, markers=%d fragments=%d", markers, fragments)
	}
	decoder := exec.CommandContext(ctx, config.Executable, "-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgra", "pipe:1")
	decoder.Stdin = &encoded
	decoded, err := decoder.Output()
	if err != nil || len(decoded) != len(frame) {
		t.Fatalf("reassembled owned-pipe access unit did not decode: %d %v", len(decoded), err)
	}
}
