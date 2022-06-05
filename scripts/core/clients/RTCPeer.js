/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Queue } from '/scripts/core/helpers/utils.module.js';

const ICE_SERVER_URLS = [
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302'
];
const CONFIGURATION = { iceServers: [{ urls: ICE_SERVER_URLS }] };
const SIXTY_FOUR_KB = 1024 * 64;

export default class RTCPeer {
    constructor(peerId, polite, socket) {
        this._peerId = peerId;
        this._polite = polite;
        this._socket = socket;
        this._connection = new RTCPeerConnection(CONFIGURATION);
        this._audio = createAudioElement();
        this._makingOffer = false;
        this._ignoreOffer = false;
        this._isSettingRemoteAnswerPending = false;
        this._hasConnected = false;
        this._sendDataChannel = null;
        this._receiveDataChannel = null;
        this._setupConnection();
        this._sendDataQueue = new Queue();
    }

    _setupConnection() {
        this._connection.ontrack = (e) => {
            e.track.onunmute = () => {
                if(this._audio.srcObject) return;
                this._audio.srcObject = e.streams[0];
            };
        };
        this._connection.onicecandidate = (e) => {
            this._socket.send(JSON.stringify({
                topic: "candidate",
                to: this._peerId,
                candidate: e.candidate,
            }));
        };
        this._connection.onnegotiationneeded = async () => {
            try {
                this._makingOffer = true;
                await this._connection.setLocalDescription();
                this._socket.send(JSON.stringify({
                    topic: "description",
                    to: this._peerId,
                    description: this._connection.localDescription,
                }));
            } catch(error) {
                console.error(error);
            } finally {
                this._makingOffer = false;
            }
        }
        this._connection.ondatachannel = (e) => {
            this._receiveDataChannel = e.channel;
            this._receiveDataChannel.onmessage = (message) => {
                if(this._onMessage) this._onMessage(message.data);
            }
        }
        this._connection.onconnectionstatechange = (e) => {
            let state = this._connection.connectionState;
            if(state == "connected" && !this._hasConnected) {
                this._hasConnected = true;
                this._setupDataChannel();
            } else if(state == "disconnected" || state == "failed") {
                if(this._onDisconnect) this._onDisconnect(e);
            }
        }
    }

    _setupDataChannel() {
        this._sendDataChannel = this._connection.createDataChannel(
            this._peerId);
        this._sendDataChannel.bufferedAmountLowThreshold = SIXTY_FOUR_KB;
        this._sendDataChannel.onopen = (e) => {
            if(this._onSendDataChannelOpen) this._onSendDataChannelOpen(e);
        }
        this._sendDataChannel.onclose = (e) => {
            if(this._onSendDataChannelClose) this._onSendDataChannelClose(e);
        }
    }

    addAudioTrack(track, srcObject) {
        this._connection.addTrack(track, srcObject);
    }

    close() {
        this._connection.close();
        this._audio.srcObject = null;
        document.body.removeChild(this._audio);
    }

    getPeerId() {
        return this._peerId;
    }

    handleCandidate(message) {
        try {
            this._connection.addIceCandidate(message.candidate);
        } catch(error) {
            if(!this._ignoreOffer) console.error(error);
        }
    }

    async handleDescription(message) {
        let description = message.description;
        try {
            let readyForOffer = !this._makingOffer
                && (this._connection.signalingState == "stable"
                    || this._isSettingRemoteAnswerPending);
            let offerCollision = description.type == "offer" && !readyForOffer;
            this._ignoreOffer = !this._polite && offerCollision;
            if(this._ignoreOffer) return;

            this._isSettingRemoteAnswerPending = description.type == "answer";
            await this._connection.setRemoteDescription(description);
            this._isSettingRemoteAnswerPending = false;
            if(description.type == "offer") {
                await this._connection.setLocalDescription();
                this._socket.send(JSON.stringify({
                    topic: "description",
                    to: this._peerId,
                    description: this._connection.localDescription,
                }));
            }
        } catch(error) {
            console.error(error);
        }
    }

    isConnected() {
        return this._hasConnected;
    }

    sendData(data) {
        this._sendDataQueue.enqueue(data);
        if(this._sendDataChannel.onbufferedamountlow) return;
        if(this._sendDataQueue.length == 1) this._sendData();
    }

    _sendData() {
        let channel = this._sendDataChannel;
        while(channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
            channel.send(this._sendDataQueue.dequeue());
            if(this._sendDataQueue.length == 0) return;
        }
        channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null;
            this._sendData();
        }
    }

    close() {
        this._connection.close();
    }

    setOnDisconnect(f) {
        this._onDisconnect = f;
    }

    setOnMessage(f) {
        this._onMessage = f;
    }

    setOnSendDataChannelOpen(f) {
        this._onSendDataChannelOpen = f;
    }

    setOnSendDataChannelClose(f) {
        this._onSendDataChannelClose = f;
    }
}

function createAudioElement() {
    let audioElement = document.createElement('audio');
    audioElement.autoplay = true;
    document.body.appendChild(audioElement);
    return audioElement;
}
