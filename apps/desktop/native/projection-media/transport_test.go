package projection

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestDirectControlAndMedia(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
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
	received := make(chan string, 4)
	video := make(chan *rtp.Packet, 1)
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		packet, _, e := track.ReadRTP()
		if e == nil {
			video <- packet
		}
	})
	viewer.OnDataChannel(func(channel *webrtc.DataChannel) {
		if channel.Label() != ControlLabel || !channel.Ordered() || channel.MaxRetransmits() != nil || channel.MaxPacketLifeTime() != nil {
			t.Error("input channel must be reliable and ordered")
			return
		}
		channel.OnOpen(func() { _ = channel.SendText(`{"input":"中文"}`) })
		channel.OnMessage(func(message webrtc.DataChannelMessage) { received <- string(message.Data) })
	})
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
	input, err := source.Receive(ctx)
	if err != nil || string(input) != `{"input":"中文"}` {
		t.Fatalf("input: %q %v", input, err)
	}
	if err = source.Send(ctx, []byte(`{"result":"applied"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-received:
		if value != `{"result":"applied"}` {
			t.Fatal(value)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: 1, Timestamp: 9000, SSRC: 123, Marker: true}, Payload: []byte{0x65, 1, 2, 3}}
	bytes, _ := packet.Marshal()
	if err = source.RTP(bytes); err != nil {
		t.Fatal(err)
	}
	select {
	case packet := <-video:
		if string(packet.Payload) != string([]byte{0x65, 1, 2, 3}) {
			t.Fatal("media payload changed")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err = source.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = source.Receive(ctx); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed input: %v", err)
	}
}

func TestRefuseRelayAndBoundMessages(t *testing.T) {
	if _, err := New(Config{STUN: []string{"turn:relay.example"}}); err == nil {
		t.Fatal("TURN was admitted")
	}
	source, err := New(Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	err = source.Remote(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: "v=0\r\na=candidate:1 1 UDP 123 192.0.2.1 1234 typ relay\r\n"})
	if !errors.Is(err, ErrRelay) {
		t.Fatalf("remote relay: %v", err)
	}
	if err = source.Send(context.Background(), make([]byte, MaxControlBytes+1)); err == nil {
		t.Fatal("unbounded control")
	}
}
