//go:build !windows

package projection

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEncoderExitKeepsStderrAndStatus(t *testing.T) {
	for _, write := range []bool{false, true} {
		name := "idle"
		if write {
			name = "during-input"
		}
		t.Run(name, func(t *testing.T) {
			for attempt := 0; attempt < 5; attempt++ {
				config := testEncoderConfig(t)
				config.Width, config.Height = 1280, 720
				config.Executable = filepath.Join(t.TempDir(), "failing-ffmpeg")
				if err := os.WriteFile(config.Executable, []byte("#!/bin/sh\nprintf '%s\\n' 'libx264 unavailable: diagnostic tail' >&2\nexit 23\n"), 0700); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				encoder, err := StartEncoder(ctx, config, ignoreRTP{})
				if err != nil {
					cancel()
					t.Fatal(err)
				}
				if write {
					err = encoder.WriteFrame(ctx, make([]byte, config.Width*config.Height*4))
				}
				select {
				case <-encoder.closed:
				case <-ctx.Done():
					_ = encoder.Close()
					cancel()
					t.Fatal("failed encoder did not exit")
				}
				failure := encoder.closedError()
				_ = encoder.Close()
				cancel()
				if !strings.Contains(failure.Error(), "exit status 23") || !strings.Contains(failure.Error(), "libx264 unavailable: diagnostic tail") {
					t.Fatalf("attempt %d lost the process failure: %v (write: %v)", attempt, failure, err)
				}
				if write && err != nil && (!strings.Contains(err.Error(), "exit status 23") || !strings.Contains(err.Error(), "diagnostic tail")) {
					t.Fatalf("write lost the process diagnostic: %v", err)
				}
			}
		})
	}
}

func TestFrameDeadlineDuringBlockedStdin(t *testing.T) {
	config := testEncoderConfig(t)
	config.Width, config.Height = 1280, 720 // Larger than the pipe; the child never reads stdin.
	config.Executable = filepath.Join(t.TempDir(), "blocked-ffmpeg")
	if err := os.WriteFile(config.Executable, []byte("#!/bin/sh\nexec /bin/sleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	video, err := StartVideoEncoder(ctx, config, ignoreRTP{})
	if err != nil {
		t.Fatal(err)
	}
	defer video.Close()
	_, err = video.WriteFrame(ctx, 1, make([]byte, config.Width*config.Height*4))
	if err == nil || err.Error() != "projection frame encoding timed out" {
		t.Fatalf("stdin timeout lost its cause: %v", err)
	}
	if !strings.Contains(video.encoder.closedError().Error(), "projection frame encoding timed out") {
		t.Fatalf("encoder retained a pipe error instead of its deadline: %v", video.encoder.closedError())
	}
}

type eofRTP struct{}

func (eofRTP) RTP([]byte) error { return io.EOF }

func TestRTPFailureStillStopsEncoderImmediately(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	config := testEncoderConfig(t)
	encoder, err := StartEncoder(ctx, config, eofRTP{})
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	if err = encoder.WriteFrame(ctx, make([]byte, config.Width*config.Height*4)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-encoder.done:
		if !errors.Is(encoder.err, io.EOF) {
			t.Fatalf("lost RTP failure: %v", encoder.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RTP failure was mistaken for stdout EOF; stdin is still open")
	}
}
