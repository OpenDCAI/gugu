//go:build helper && !windows

package projection

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
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

func TestParentDeadlineAlsoBoundsColdStart(t *testing.T) {
	path := t.TempDir() + "/stalled-encoder"
	if err := os.WriteFile(path, []byte("#!/bin/sh\nwhile IFS= read -r line; do :; done\n"), 0700); err != nil {
		t.Fatal(err)
	}
	config := testEncoderConfig(t)
	config.Executable = path
	video, err := StartVideoEncoder(context.Background(), config, ignoreRTP{})
	if err != nil {
		t.Fatal(err)
	}
	defer video.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, err = video.WriteFrame(ctx, 1, make([]byte, config.Width*config.Height*4))
	if err == nil || err != context.DeadlineExceeded {
		t.Fatalf("missing parent deadline during cold start: %v", err)
	}
}

func TestIdleHelperExitsAfterPeerOrEncoderFailure(t *testing.T) {
	for _, reason := range []string{"peer closed", "encoder failed"} {
		t.Run(reason, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			config := testEncoderConfig(t)
			trigger := t.TempDir() + "/exit"
			if reason == "encoder failed" {
				config.Executable = t.TempDir() + "/failing-encoder"
				if err := os.WriteFile(config.Executable, []byte("#!/bin/sh\nwhile [ ! -f '"+trigger+"' ]; do /bin/sleep 0.05; done\nexit 17\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.CommandContext(ctx, os.Getenv("GUGU_TEST_MEDIA_HELPER"), "-ffmpeg", config.Executable, "-width", "128", "-height", "96", "-fps", "10", "-bitrate", "500000", "-test-loopback")
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
			exited := make(chan struct{})
			var exitErr error
			go func() { exitErr = cmd.Wait(); close(exited) }()
			defer func() { cancel(); _ = input.Close(); <-exited }()
			messages := make(chan MediaMessage, 8)
			go func() {
				defer close(messages)
				for {
					_, data, readErr := readWire(output, 0)
					if readErr != nil {
						return
					}
					var message MediaMessage
					if json.Unmarshal(data, &message) != nil {
						return
					}
					select {
					case messages <- message:
					case <-ctx.Done():
						return
					}
				}
			}()
			next := func(kind string) MediaMessage {
				for {
					select {
					case message, open := <-messages:
						if !open {
							t.Fatalf("helper closed before %s", kind)
						}
						if message.Type == "error" {
							t.Fatalf("helper failed before trigger: %s", message.Error)
						}
						if message.Type == kind {
							return message
						}
					case <-ctx.Done():
						t.Fatalf("helper did not emit %s", kind)
					}
				}
			}
			offer := next("offer")
			viewer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			defer viewer.Close()
			viewer.OnDataChannel(func(channel *webrtc.DataChannel) { channel.OnMessage(func(webrtc.DataChannelMessage) {}) })
			if err = viewer.SetRemoteDescription(*offer.SDP); err != nil {
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
			if err = writeMessage(input, MediaMessage{Type: "answer", ID: 1, SDP: viewer.LocalDescription()}); err != nil {
				t.Fatal(err)
			}
			_ = next("ready") // proves the helper returned to idle with an encoder alive
			if reason == "peer closed" {
				err = viewer.Close()
			} else {
				err = os.WriteFile(trigger, nil, 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-exited:
				if exitErr == nil {
					t.Fatal("media failure was reported as a successful exit")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("helper remained blocked on parent stdin after media failure")
			}
		})
	}
}
