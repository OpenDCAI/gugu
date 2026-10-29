//go:build helper && !windows

package projection

import (
	"context"
	"io"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

func TestIdleHelperRespondsToSignalsAndEOF(t *testing.T) {
	for _, end := range []string{"SIGTERM", "SIGINT", "EOF"} {
		t.Run(end, func(t *testing.T) {
			config := testEncoderConfig(t)
			cmd := exec.Command(os.Getenv("GUGU_TEST_MEDIA_HELPER"), "-ffmpeg", config.Executable, "-width", "128", "-height", "96", "-fps", "10", "-bitrate", "500000")
			input, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			output, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			exited := make(chan error, 1)
			go func() { exited <- cmd.Wait() }()
			defer input.Close()
			defer output.Close()
			if _, _, err = readWire(output, 0); err != nil {
				_ = cmd.Process.Kill()
				<-exited
				t.Fatal(err)
			}
			go func() { _, _ = io.Copy(io.Discard, output) }()
			if end == "EOF" {
				err = input.Close()
			} else if end == "SIGTERM" {
				err = cmd.Process.Signal(syscall.SIGTERM)
			} else {
				err = cmd.Process.Signal(os.Interrupt)
			}
			if err != nil {
				_ = cmd.Process.Kill()
				<-exited
				t.Fatal(err)
			}
			select {
			case err = <-exited:
				if end == "EOF" && err != nil {
					t.Fatalf("EOF did not exit cleanly: %v", err)
				}
			case <-time.After(3 * time.Second):
				_ = cmd.Process.Kill()
				<-exited
				t.Fatal("idle helper ignored termination while its parent kept stdin open")
			}
		})
	}
}

func TestFrameEncodingHasItsOwnDeadline(t *testing.T) {
	path := t.TempDir() + "/stalled-encoder"
	if err := os.WriteFile(path, []byte("#!/bin/sh\nwhile IFS= read -r line; do :; done\n"), 0700); err != nil {
		t.Fatal(err)
	}
	config := testEncoderConfig(t)
	config.Executable = path
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	video, err := StartVideoEncoder(ctx, config, ignoreRTP{})
	if err != nil {
		t.Fatal(err)
	}
	defer video.Close()
	_, err = video.WriteFrame(ctx, 1, make([]byte, config.Width*config.Height*4))
	if err == nil || err.Error() != "projection frame encoding timed out" {
		t.Fatalf("missing per-frame encoding deadline: %v", err)
	}
}
