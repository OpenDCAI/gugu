//go:build !windows

package projection

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type encoderFixturePlan struct {
	Size                                     int
	Gate, Waiting, Verified, Encoded, FFmpeg string
	Delay                                    time.Duration
}

// This test binary is also a deliberately blocked encoder process. No external
// sleep child can be orphaned when its owning Encoder is cancelled.
func TestProjectionEncoderFixture(t *testing.T) {
	path := os.Getenv("GUGU_PROJECTION_ENCODER_PLAN")
	if path == "" {
		t.Skip("encoder subprocess fixture")
	}
	fail := func(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(93) }
	data, err := os.ReadFile(path)
	if err != nil {
		fail(err)
	}
	var plan encoderFixturePlan
	if err = json.Unmarshal(data, &plan); err != nil {
		fail(err)
	}
	if plan.FFmpeg != "" {
		time.Sleep(plan.Delay)
		if err = syscall.Exec(plan.FFmpeg, append([]string{plan.FFmpeg}, flag.Args()...), os.Environ()); err != nil {
			fail(err)
		}
		return
	}
	pixels := make([]byte, plan.Size)
	prefix := min(len(pixels), 64*1024)
	if _, err = io.ReadFull(os.Stdin, pixels[:prefix]); err != nil {
		fail(err)
	}
	if plan.Waiting != "" {
		if err = os.WriteFile(plan.Waiting, []byte("blocked"), 0600); err != nil {
			fail(err)
		}
		for {
			if _, err = os.Stat(plan.Gate); err == nil {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	if _, err = io.ReadFull(os.Stdin, pixels[prefix:]); err != nil {
		fail(err)
	}
	if !bytes.Equal(pixels, bytes.Repeat([]byte{17}, plan.Size)) {
		fail(fmt.Errorf("borrowed raw picture changed before encoding completed"))
	}
	if plan.Verified != "" {
		if err = os.WriteFile(plan.Verified, []byte("unchanged"), 0600); err != nil {
			fail(err)
		}
	}
	encoded, err := os.ReadFile(plan.Encoded)
	if err != nil {
		fail(err)
	}
	if err = writeAll(os.Stdout, encoded); err != nil {
		fail(err)
	}
	time.Sleep(time.Minute) // Warm subsequent writes remain blocked, until owned cancellation.
}

func encoderFixtureExecutable(t *testing.T, plan encoderFixturePlan) string {
	t.Helper()
	root := t.TempDir()
	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "plan.json")
	if err = os.WriteFile(path, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
	script := filepath.Join(root, "encoder")
	content := "#!/bin/sh\nGUGU_PROJECTION_ENCODER_PLAN=" + quote(path) + " exec " + quote(binary) + " -test.run '^TestProjectionEncoderFixture$' -- \"$@\"\n"
	if err = os.WriteFile(script, []byte(content), 0700); err != nil {
		t.Fatal(err)
	}
	return script
}

func oneEncodedFixture(t *testing.T, config EncoderConfig) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, config.Executable, "-v", "error", "-f", "rawvideo", "-pixel_format", "bgra", "-video_size", fmt.Sprintf("%dx%d", config.Width, config.Height), "-i", "pipe:0", "-frames:v", "1", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-bf", "0", "-f", "flv", "pipe:1")
	command.Stdin = bytes.NewReader(make([]byte, config.Width*config.Height*4))
	var diagnostics bytes.Buffer
	command.Stderr = &diagnostics
	data, err := command.Output()
	if err != nil {
		t.Fatalf("encode owned fixture: %v: %s", err, &diagnostics)
	}
	path := filepath.Join(t.TempDir(), "frame.flv")
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestColdStartAndRecoveryHaveTheirOwnAllowance(t *testing.T) {
	config := testEncoderConfig(t)
	config.Executable = encoderFixtureExecutable(t, encoderFixturePlan{FFmpeg: config.Executable, Delay: 3200 * time.Millisecond})
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	video, err := StartVideoEncoder(ctx, config, ignoreRTP{})
	if err != nil {
		t.Fatal(err)
	}
	defer video.Close()
	started := time.Now()
	first, err := video.WriteFrame(ctx, 1, make([]byte, config.Width*config.Height*4))
	if err != nil || time.Since(started) < 3*time.Second {
		t.Fatalf("healthy cold start lost its allowance: %+v %v", first, err)
	}
	started = time.Now()
	recovered, err := video.RefreshFrame(ctx)
	if err != nil || !recovered.Recovery || time.Since(started) < 3*time.Second {
		t.Fatalf("replacement cold start lost its allowance: %+v %v", recovered, err)
	}
}

func TestColdStartHasItsOwnFiniteDeadline(t *testing.T) {
	config := testEncoderConfig(t)
	config.Executable = encoderFixtureExecutable(t, encoderFixturePlan{FFmpeg: config.Executable, Delay: time.Minute})
	ctx, cancel := context.WithTimeout(context.Background(), 11*time.Second)
	defer cancel()
	video, err := StartVideoEncoder(ctx, config, ignoreRTP{})
	if err != nil {
		t.Fatal(err)
	}
	defer video.Close()
	_, err = video.WriteFrame(ctx, 1, make([]byte, config.Width*config.Height*4))
	if err == nil || err.Error() != "projection encoder startup timed out" {
		t.Fatalf("cold-start deadline lost its distinct cause: %v", err)
	}
}
