//go:build !windows

package projection

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestServiceRetainsSlabUntilBlockedEncoderFinishes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	config := testEncoderConfig(t)
	config.Width, config.Height = 1280, 720
	root := t.TempDir()
	plan := encoderFixturePlan{Size: config.Width * config.Height * 4, Waiting: filepath.Join(root, "waiting"), Gate: filepath.Join(root, "continue"), Verified: filepath.Join(root, "verified"), Encoded: oneEncodedFixture(t, config)}
	config.Executable = encoderFixtureExecutable(t, plan)
	input, hostInput := io.Pipe()
	hostOutput, output := io.Pipe()
	served := make(chan struct{})
	var serviceErr error
	go func() { serviceErr = ServeMedia(ctx, Config{Loopback: true}, config, input, output); close(served) }()
	messages := make(chan MediaMessage, 16)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer close(messages)
		for {
			_, data, err := readWire(hostOutput, 0)
			if err != nil {
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
	var second chan error
	secondRead := false
	defer func() {
		cancel()
		_ = hostInput.Close()
		_ = hostOutput.Close()
		<-served
		<-readerDone
		if second != nil && !secondRead {
			select {
			case <-second:
			case <-time.After(time.Second):
				t.Error("owned input writer remained blocked")
			}
		}
	}()
	next := func(kind string) MediaMessage {
		t.Helper()
		for {
			select {
			case message, ok := <-messages:
				if !ok {
					<-served
					t.Fatalf("service closed before expected receipt: %v", serviceErr)
				}
				if message.Type == "error" {
					t.Fatalf("blocked service corrupted its borrowed picture: %s", message.Error)
				}
				if message.Type == kind {
					return message
				}
			case <-ctx.Done():
				t.Fatalf("missing service %s: %v", kind, ctx.Err())
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
	if err = writeMessage(hostInput, MediaMessage{Type: "answer", ID: 1, SDP: viewer.LocalDescription()}); err != nil {
		t.Fatal(err)
	}
	_ = next("ready")
	frame := func(sequence uint64, value byte) []byte {
		payload := bytes.Repeat([]byte{value}, 8+plan.Size)
		binary.BigEndian.PutUint64(payload, sequence)
		return payload
	}
	if err = writeWire(hostInput, wireFrame, frame(1, 17)); err != nil {
		t.Fatal(err)
	}
	for {
		if _, err = os.Stat(plan.Waiting); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("encoder did not enter blocked state")
		case <-time.After(5 * time.Millisecond):
		}
	}
	second = make(chan error, 1)
	go func() { second <- writeWire(hostInput, wireFrame, frame(2, 99)) }()
	consumedEarly := false
	select {
	case err = <-second:
		secondRead = true
		if err != nil {
			t.Fatal(err)
		}
		consumedEarly = true
	case <-time.After(150 * time.Millisecond):
	}
	// Let the actual encoder subprocess finish reading the original bytes. It
	// checks every byte before producing a valid encoded access unit.
	if err = os.WriteFile(plan.Gate, []byte("continue"), 0600); err != nil {
		t.Fatal(err)
	}
	receipt := next("encoded")
	if receipt.Frame == nil || receipt.Frame.Sequence != 1 {
		t.Fatal("wrong first source receipt")
	}
	verified, err := os.ReadFile(plan.Verified)
	if err != nil || string(verified) != "unchanged" {
		t.Fatalf("first slab was not verified intact: %s %v", verified, err)
	}
	if consumedEarly {
		t.Fatal("service returned its slab and read the next picture before encoding finished")
	}
	cancel()
	_ = hostInput.Close()
	if !consumedEarly {
		select {
		case <-second:
			secondRead = true
		case <-time.After(time.Second):
			t.Fatal("cancelled second write did not return")
		}
	}
}
