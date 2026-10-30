// Package projection supplies the host's media transport, shared by desktop and headless server.
// Authorization, target selection and execution acknowledgements belong to the host binding above it.
package projection

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const ControlLabel = "gugu-projection-input"
const MaxControlBytes = 16 * 1024
const highWater = 256 * 1024

var ErrClosed = errors.New("projection media closed")
var ErrRelay = errors.New("projection requires a direct connection")

// Config is supplied by the host, never by an App's tool arguments.
type Config struct {
	STUN []string
	// Local tests opt into loopback candidates without changing any machine network setting.
	Loopback bool
}

type Transport struct {
	peer         *webrtc.PeerConnection
	video        *webrtc.TrackLocalStaticRTP
	control      *webrtc.DataChannel
	selectedPair func() (*webrtc.ICECandidatePair, error)
	done         chan struct{}
	closed       chan struct{}
	closeErr     error
	reason       error
	open         chan struct{}
	low          chan struct{}
	incoming     chan []byte
	keyframes    chan struct{}
	once         sync.Once
	opened       sync.Once
}

func New(config Config) (*Transport, error) {
	servers := make([]webrtc.ICEServer, 0, len(config.STUN))
	for _, url := range config.STUN {
		if len(url) > 512 || !(strings.HasPrefix(url, "stun:") || strings.HasPrefix(url, "stuns:")) {
			return nil, errors.New("only STUN discovery is allowed for direct projection")
		}
		servers = append(servers, webrtc.ICEServer{URLs: []string{url}})
	}
	media := &webrtc.MediaEngine{}
	err := media.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
		SDPFmtpLine:  "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}},
	}, PayloadType: 96}, webrtc.RTPCodecTypeVideo)
	if err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	if err = webrtc.RegisterDefaultInterceptors(media, registry); err != nil {
		return nil, err
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(config.Loopback)
	peer, err := webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return nil, err
	}
	t := &Transport{peer: peer, done: make(chan struct{}), closed: make(chan struct{}), open: make(chan struct{}), low: make(chan struct{}, 1), incoming: make(chan []byte, 64), keyframes: make(chan struct{}, 1)}
	t.selectedPair = func() (*webrtc.ICECandidatePair, error) {
		if peer.SCTP() == nil || peer.SCTP().Transport() == nil {
			return nil, errors.New("projection transport is not connected")
		}
		return peer.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	}
	fail := func(err error) (*Transport, error) { t.stop(err); return nil, err }
	t.video, err = webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264}, "projection", "projection")
	if err != nil {
		return fail(err)
	}
	sender, err := peer.AddTrack(t.video)
	if err != nil {
		return fail(err)
	}
	// Read authenticated RTCP through Pion, retaining default NACK handling.
	// One pending request is enough; the service applies a timed recovery budget.
	go func() {
		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}
			for _, packet := range packets {
				if _, ok := packet.(*rtcp.PictureLossIndication); ok {
					select {
					case t.keyframes <- struct{}{}:
					default:
					}
				}
			}
		}
	}()
	t.control, err = peer.CreateDataChannel(ControlLabel, &webrtc.DataChannelInit{Ordered: ptr(true)})
	if err != nil {
		return fail(err)
	}
	t.control.SetBufferedAmountLowThreshold(highWater / 4)
	t.control.OnBufferedAmountLow(func() {
		select {
		case t.low <- struct{}{}:
		default:
		}
	})
	t.control.OnOpen(func() {
		if err := t.direct(); err != nil {
			t.stop(err)
			return
		}
		t.opened.Do(func() { close(t.open) })
	})
	t.control.OnClose(func() { t.stop(errors.New("projection control closed")) })
	t.control.OnMessage(func(message webrtc.DataChannelMessage) {
		if t.direct() != nil || !message.IsString || len(message.Data) > MaxControlBytes {
			t.stop(errors.New("invalid projection control message"))
			return
		}
		data := append([]byte(nil), message.Data...)
		select {
		case t.incoming <- data:
		case <-t.done:
		default:
			t.stop(errors.New("projection control queue is full"))
		}
	})
	peer.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			if err := t.direct(); err != nil {
				t.stop(err)
			}
		}
		if state == webrtc.PeerConnectionStateDisconnected || state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			t.stop(fmt.Errorf("projection connection %s", state))
		}
	})
	return t, nil
}

func ptr[T any](value T) *T { return &value }

func (t *Transport) direct() error {
	select {
	case <-t.done:
		return t.closedError()
	default:
	}
	if t.selectedPair == nil {
		return errors.New("projection transport is not connected")
	}
	pair, err := t.selectedPair()
	if err != nil || pair == nil {
		return errors.New("projection has no selected candidate pair")
	}
	if pair.Local == nil || pair.Remote == nil {
		return errors.New("projection candidate pair is incomplete")
	}
	if pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay {
		return ErrRelay
	}
	return nil
}

// Remote rejects relay candidates on both sides of the SDP boundary. Transport readiness is checked again at use.
func (t *Transport) Remote(description webrtc.SessionDescription) error {
	if len(description.SDP) > 128*1024 {
		return errors.New("projection description is too large")
	}
	for _, line := range strings.Split(description.SDP, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) == 0 || !strings.HasPrefix(fields[0], "a=candidate:") {
			continue
		}
		for i := 0; i+1 < len(fields); i++ {
			if fields[i] == "typ" && fields[i+1] == "relay" {
				return ErrRelay
			}
		}
	}
	return t.peer.SetRemoteDescription(description)
}

func (t *Transport) Offer(ctx context.Context) (webrtc.SessionDescription, error) {
	description, err := t.peer.CreateOffer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	gathered := webrtc.GatheringCompletePromise(t.peer)
	if err = t.peer.SetLocalDescription(description); err != nil {
		return webrtc.SessionDescription{}, err
	}
	select {
	case <-ctx.Done():
		_ = t.Close()
		return webrtc.SessionDescription{}, ctx.Err()
	case <-t.done:
		return webrtc.SessionDescription{}, ErrClosed
	case <-gathered:
	}
	return *t.peer.LocalDescription(), nil
}

func (t *Transport) Ready(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.done:
		return t.closedError()
	case <-t.open:
		return t.direct()
	}
}

func (t *Transport) Receive(ctx context.Context) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.done:
		return nil, t.closedError()
	case data := <-t.incoming:
		if err := t.direct(); err != nil {
			return nil, err
		}
		return data, nil
	}
}

// Send means handed to SCTP, never that a native action was applied. The host still needs the execution result.
func (t *Transport) Send(ctx context.Context, data []byte) error {
	if len(data) > MaxControlBytes {
		return errors.New("projection control message is too large")
	}
	if err := t.Ready(ctx); err != nil {
		return err
	}
	for t.control.BufferedAmount() > highWater {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.done:
			return ErrClosed
		case <-t.low:
		}
	}
	if err := t.direct(); err != nil {
		return err
	}
	return t.control.SendText(string(data))
}

// RTP is already encoded H.264 from the host encoder. It never travels over the control channel.
func (t *Transport) RTP(data []byte) error {
	if err := t.direct(); err != nil {
		return err
	}
	if len(data) > 1500 {
		return errors.New("projection RTP packet is too large")
	}
	packet := &rtp.Packet{}
	if err := packet.Unmarshal(data); err != nil {
		return fmt.Errorf("invalid projection RTP: %w", err)
	}
	return t.video.WriteRTP(packet)
}

func (t *Transport) stop(reason error) {
	t.once.Do(func() {
		t.reason = reason
		close(t.done)
		go func() { t.closeErr = t.peer.Close(); close(t.closed) }()
	})
}

func (t *Transport) Close() error {
	t.stop(nil)
	<-t.closed
	return t.closeErr
}

func (t *Transport) closedError() error {
	if t.reason == nil {
		return ErrClosed
	}
	return fmt.Errorf("%w: %v", ErrClosed, t.reason)
}
