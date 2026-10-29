//go:build helper

package projection

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestNativeMediaProcessFramesControlAndClose(t *testing.T) {
	helper := os.Getenv("GUGU_TEST_MEDIA_HELPER")
	if helper == "" {
		t.Fatal("helper-tagged tests require GUGU_TEST_MEDIA_HELPER")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	config := testEncoderConfig(t)
	cmd := exec.CommandContext(ctx, helper, "-ffmpeg", config.Executable, "-width", "128", "-height", "96", "-fps", "10", "-bitrate", "500000", "-test-loopback")
	diagnostics := &encoderLog{}
	cmd.Stderr = diagnostics
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, outputWriter := io.Pipe()
	cmd.Stdout = outputWriter
	defer output.Close()
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	var exitErr error
	go func() { exitErr = cmd.Wait(); _ = outputWriter.Close(); close(exited) }()
	defer func() { cancel(); <-exited }()
	messages := make(chan MediaMessage, 64)
	var outputErr error
	go func() {
		defer close(messages)
		for {
			kind, data, readErr := readWire(output, 0)
			if readErr != nil {
				outputErr = readErr
				return
			}
			var message MediaMessage
			if kind != wireJSON {
				outputErr = errors.New("helper emitted raw video on control pipe")
				return
			}
			if readErr = json.Unmarshal(data, &message); readErr != nil {
				outputErr = readErr
				return
			}
			select {
			case messages <- message:
			case <-ctx.Done():
				return
			}
		}
	}()
	var controls []string
	next := func(kind string) MediaMessage {
		for {
			select {
			case message, open := <-messages:
				if !open {
					t.Fatalf("helper output: %v; stderr: %s", outputErr, diagnostics.text())
				}
				if message.Type == "control" {
					controls = append(controls, message.Data)
				}
				if message.Type == "error" {
					t.Fatalf("helper failed: %s", message.Error)
				}
				if message.Type == kind {
					return message
				}
			case <-ctx.Done():
				t.Fatalf("helper did not emit %s: %s", kind, diagnostics.text())
			}
		}
	}
	offer := next("offer")
	if offer.SDP == nil {
		t.Fatal("helper omitted its actual offer")
	}
	viewer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.Close()
	encoded := make(chan MediaMessage, 4)
	result := make(chan string, 1)
	stamps := make(chan uint32, 16)
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			if packet.Marker {
				select {
				case stamps <- packet.Timestamp:
				case <-ctx.Done():
					return
				}
			}
		}
	})
	const fromViewer = `{"input":"中文🙂"}`
	const fromHost = `{"result":"applied"}`
	viewer.OnDataChannel(func(channel *webrtc.DataChannel) {
		channel.OnOpen(func() { _ = channel.SendText(fromViewer) })
		channel.OnMessage(func(packet webrtc.DataChannelMessage) {
			if string(packet.Data) == fromHost {
				result <- string(packet.Data)
				return
			}
			var message MediaMessage
			if json.Unmarshal(packet.Data, &message) == nil {
				encoded <- message
			}
		})
	})
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
	if ready := next("ready"); ready.ID != 1 {
		t.Fatalf("wrong readiness receipt: %+v", ready)
	}
	for index := 0; index < 3; index++ {
		frame := make([]byte, 8+config.Width*config.Height*4)
		sequence := uint64(401 + index)
		binary.BigEndian.PutUint64(frame[:8], sequence)
		for i := 8; i < len(frame); i += 4 {
			frame[i+index] = 230
			frame[i+3] = 255
		}
		if err = writeWire(input, wireFrame, frame); err != nil {
			t.Fatal(err)
		}
		receipt := next("encoded")
		if receipt.Frame == nil || receipt.Frame.Sequence != sequence {
			t.Fatalf("wrong source receipt: %+v", receipt)
		}
		select {
		case stamp := <-stamps:
			if stamp != receipt.Frame.Timestamp {
				t.Fatal("native IPC frame receipt differs from actual SRTP frame")
			}
		case <-ctx.Done():
			t.Fatal("helper did not deliver video")
		}
		select {
		case metadata := <-encoded:
			if metadata.Type != "frame" || metadata.Frame == nil || *metadata.Frame != *receipt.Frame {
				t.Fatal("direct frame metadata lost its source association")
			}
		case <-ctx.Done():
			t.Fatal("helper did not deliver direct metadata")
		}
	}
	if err = writeMessage(input, MediaMessage{Type: "send", ID: 2, Data: fromHost}); err != nil {
		t.Fatal(err)
	}
	if sent := next("sent"); sent.ID != 2 {
		t.Fatal("wrong SCTP admission receipt")
	}
	select {
	case value := <-result:
		if value != fromHost {
			t.Fatal(value)
		}
	case <-ctx.Done():
		t.Fatal("host result did not cross the direct data channel")
	}
	if len(controls) == 0 {
		_ = next("control")
	}
	if len(controls) != 1 || controls[0] != fromViewer {
		t.Fatalf("viewer input changed or replayed: %v", controls)
	}
	if err = writeMessage(input, MediaMessage{Type: "close", ID: 9}); err != nil {
		t.Fatal(err)
	}
	if closed := next("closed"); closed.ID != 9 {
		t.Fatal("wrong cleanup receipt")
	}
	select {
	case <-exited:
		if exitErr != nil {
			t.Fatalf("helper did not exit cleanly: %v: %s", exitErr, diagnostics.text())
		}
	case <-ctx.Done():
		t.Fatal("helper retained its encoder/socket after close")
	}
}
