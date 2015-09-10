/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var path = require('path');
var express = require('express');
var ws = require('ws');
var minimist = require('minimist');
var url = require('url');
var kurento = require('kurento-client');

var argv = minimist(process.argv.slice(2), {
  default: {
      as_uri: "http://localhost:8080/",
      ws_uri: "ws://localhost:8888/kurento"
  }
});

var app = express();

/*
 * Definition of global variables.
 */

var kurentoClient = null;
var userRegistry = new UserRegistry();
var pipelines = {};
var playPipelines = {};
var candidatesQueue = {};
var idCounter = 0;

function nextUniqueId() {
    idCounter++;
    return idCounter.toString();
}

/*
 * Definition of helper classes
 */

// Represents caller and callee sessions
function UserSession(id, name, ws) {
    this.id = id;
    this.name = name;
    this.ws = ws;
    this.peer = null;
    this.sdpOffer = null;
}

UserSession.prototype.sendMessage = function(message) {
    this.ws.send(JSON.stringify(message));
}

// Represents registrar of users
function UserRegistry() {
    this.usersById = {};
    this.usersByName = {};
}

UserRegistry.prototype.register = function(user) {
    this.usersById[user.id] = user;
    this.usersByName[user.name] = user;
}

UserRegistry.prototype.unregister = function(id) {
    var user = this.getById(id);
    if (user) delete this.usersById[id]
    if (user && this.getByName(user.name)) delete this.usersByName[user.name];
}

UserRegistry.prototype.getById = function(id) {
    return this.usersById[id];
}

UserRegistry.prototype.getByName = function(name) {
    return this.usersByName[name];
}

UserRegistry.prototype.removeById = function(id) {
    var userSession = this.usersById[id];
    if (!userSession) return;
    delete this.usersById[id];

    delete this.usersByName[userSession.name];
}

// Represents a B2B active call
function CallMediaPipeline() {
    this.pipeline = null;
    this.webRtcEndpoint = {};
    this.callRecorder = {};
}

CallMediaPipeline.prototype.createPipeline = function(callerId, calleeId, ws, callback) {
    var self = this;
    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }

            pipeline.create('WebRtcEndpoint', function(error, callerWebRtcEndpoint) {
                if (error) {
                    pipeline.release();
                    return callback(error);
                }

                if (candidatesQueue[callerId]) {
                    while(candidatesQueue[callerId].length) {
                        var candidate = candidatesQueue[callerId].shift();
                        callerWebRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                callerWebRtcEndpoint.on('OnIceCandidate', function(event) {
                    var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                    userRegistry.getById(callerId).ws.send(JSON.stringify({
                        id : 'iceCandidate',
                        candidate : candidate
                    }));
                });

                pipeline.create('WebRtcEndpoint', function(error, calleeWebRtcEndpoint) {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }

                    if (candidatesQueue[calleeId]) {
                        while(candidatesQueue[calleeId].length) {
                            var candidate = candidatesQueue[calleeId].shift();
                            calleeWebRtcEndpoint.addIceCandidate(candidate);
                        }
                    }

                    calleeWebRtcEndpoint.on('OnIceCandidate', function(event) {
                        var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                        userRegistry.getById(calleeId).ws.send(JSON.stringify({
                            id : 'iceCandidate',
                            candidate : candidate
                        }));
                    });
                    
                    
                    pipeline.create('RecorderEndpoint', {uri: 'file:///tmp/recording.webm'}, function(error, callRecorder) {
                        
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }
                        
                        pipeline.create('Composite', function(error, composite) {

                            if (error) {
                              pipeline.release();
                              return callback(error);
                            }

                            composite.createHubPort(function(error, callerHubPort) {

                                if(error) {
                                    pipeline.release();
                                    return callback(error);
                                }

                                composite.createHubPort(function(error, calleeHubPort) {

                                    if(error) {
                                        pipeline.release();
                                        return callback(error);
                                    }

                                    callerWebRtcEndpoint.connect(calleeWebRtcEndpoint, function(error) {
                                        if (error) {
                                            pipeline.release();
                                            return callback(error);
                                        }

                                        calleeWebRtcEndpoint.connect(callerWebRtcEndpoint, function(error) {
                                            if (error) {
                                                pipeline.release();
                                                return callback(error);
                                            }

                                            callerWebRtcEndpoint.connect(callerHubPort, function(error) {
                                                if (error) {
                                                    pipeline.release();
                                                    return callback(error);
                                                }

                                                calleeWebRtcEndpoint.connect(calleeHubPort, function(error) {
                                                    if (error) {
                                                        pipeline.release();
                                                        return callback(error);
                                                    }

                                                    calleeHubPort.connect(callRecorder, function(error) {
                                                        if(error) {
                                                            pipeline.release();
                                                            return callback(error);
                                                        }

                                                        callerHubPort.connect(callRecorder, function(error) {
                                                            if(error) {
                                                                pipeline.release();
                                                                return callback(error);
                                                            }
                                                            self.pipeline = pipeline;
                                                            self.webRtcEndpoint[callerId] = callerWebRtcEndpoint;
                                                            self.webRtcEndpoint[calleeId] = calleeWebRtcEndpoint;
                                                            self.callRecorder = callRecorder;
                                                            callback(null);
                                                        })

                                                    })
                                                                
                                                });
                                            });
                                        });
                                    });

                                });
                            
                            });

                        });

                    });
                });
            });
        });
    })
}

CallMediaPipeline.prototype.generateSdpAnswer = function(id, sdpOffer, callback) {
    this.webRtcEndpoint[id].processOffer(sdpOffer, callback);
    this.webRtcEndpoint[id].gatherCandidates(function(error) {
        if (error) {
            return callback(error);
        }
    });
}

CallMediaPipeline.prototype.release = function() {
    if (this.pipeline) this.pipeline.release();
    this.pipeline = null;
}

CallMediaPipeline.prototype.record = function() {
    var self = this;
    self.callRecorder.record(function() {
        console.log('recording');
    });
}

function PlayMediaPipeline() {
    this.pipeline = null;
    this.webRtcEndpoint = null;
    this.playerEndpoint = null;
}

PlayMediaPipeline.prototype.createPipeline = function(userId, ws, callback) {
    var self = this;
    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }

            pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
                if (error) {
                    pipeline.release();
                    return callback(error);
                }

                if (candidatesQueue[userId]) {
                    while(candidatesQueue[userId].length) {
                        var candidate = candidatesQueue[userId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                webRtcEndpoint.on('OnIceCandidate', function(event) {
                    var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                    ws.send(JSON.stringify({
                        id : 'iceCandidate',
                        candidate : candidate
                    }));
                });


                pipeline.create('PlayerEndpoint', {uri: 'file:///tmp/recording.webm'}, function(error, playerEndpoint) {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }

                    playerEndpoint.on("EndOfStream", function() {
                        console.log('ended');
                        ws.send(JSON.stringify({
                            id : 'playEnd'
                        }));
                    });

                    playerEndpoint.on("Error", function() {
                        console.log('error occurred');
                    })

                    playerEndpoint.connect(webRtcEndpoint, function(error) {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }

                        self.pipeline = pipeline;
                        self.webRtcEndpoint = webRtcEndpoint;
                        self.playerEndpoint = playerEndpoint;
                        callback(null);
                    });
                });
            });
        });
    });
}

PlayMediaPipeline.prototype.play = function() {
    var self = this;
    this.playerEndpoint.play();
};

PlayMediaPipeline.prototype.generateSdpAnswer = function(sdpOffer, callback) {
    this.webRtcEndpoint.processOffer(sdpOffer, callback);
    this.webRtcEndpoint.gatherCandidates(function(error) {
        if (error) {
            return callback(error);
        }
    });
};


/*
 * Server startup
 */

var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = app.listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/one2one'
});


// upon connection with a client, a unique session ID is created for this socket connection
// the sessionID can be accessed from within the 'error', 'close', and 'message' event handlers
wss.on('connection', function(ws) {
    var sessionId = nextUniqueId();
    console.log('Connection received with sessionId ' + sessionId);

    // informs of a connection error
    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
        userRegistry.unregister(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'register':
            register(sessionId, message.name, ws);
            break;

        case 'call':
            call(sessionId, message.to, message.from, message.sdpOffer);
            break;

        case 'incomingCallResponse':
            incomingCallResponse(sessionId, message.from, message.callResponse, message.sdpOffer, ws);
            break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

        case 'onPlayIceCandidate':
            onPlayIceCandidate(sessionId, message.candidate);
            break;

        case 'play':
            play(sessionId, message);
            break;

        case 'readyToPlay':
            startPlaying(sessionId);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});

function play(sessionId, message) {

    var user = userRegistry.getByName(message.user); // get User Session object of the requested recording
    clearCandidatesQueue(sessionId); // clear ICE candidates made from previous call
    var socket = userRegistry.getById(sessionId).ws; // get socket connection of the requesting user 
    if(socket) {
        var pipeline = new PlayMediaPipeline();
        playPipelines[sessionId] = pipeline;

        console.log('found user!')
        pipeline.createPipeline(sessionId, socket, function(error) {
            if (error) {
                return onError(error, error);
            }
            console.log('Created Player Pipeline!');
            pipeline.generateSdpAnswer(message.sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    return onError(error, error);
                }

                console.log('Generated SDP Answer!');
                var responseMessage = {
                    id: 'playResponse',
                    response : 'accepted',
                    sdpAnswer: sdpAnswer
                };

                socket.send(JSON.stringify(responseMessage));

            });
        });
        
    }
}

function startPlaying(sessionId) {
    if (!playPipelines[sessionId]) {
        return;
    }
    playPipelines[sessionId].play();
}

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            var message = 'Coult not find media server at address ' + argv.ws_uri;
            return callback(message + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function stop(sessionId) {
    if (!pipelines[sessionId]) {
        return;
    }

    var pipeline = pipelines[sessionId]; // sessionIds are stored in global pipelines object
    delete pipelines[sessionId]; // session deleted from local storage
    pipeline.release(); // pipeline released (practically deleted) in Kurento Media server 
    var stopperUser = userRegistry.getById(sessionId); // gets the user object from registry of user doing the stopping
    var stoppedUser = userRegistry.getByName(stopperUser.peer); // gets peer from registry
    stopperUser.peer = null; // sets peer to null

    if (stoppedUser) {
        stoppedUser.peer = null;
        delete pipelines[stoppedUser.id]; // session deleted from local storage
        var message = {
            id: 'stopCommunication',
            message: 'remote user hanged out'
        }
        stoppedUser.sendMessage(message)
    }

    clearCandidatesQueue(sessionId);
}

function incomingCallResponse(calleeId, from, callResponse, calleeSdp, ws) {

    clearCandidatesQueue(calleeId);

    function onError(callerReason, calleeReason) {
        if (pipeline) pipeline.release();
        if (caller) {
            var callerMessage = {
                id: 'callResponse',
                response: 'rejected'
            }
            if (callerReason) callerMessage.message = callerReason;
            caller.sendMessage(callerMessage);
        }

        var calleeMessage = {
            id: 'stopCommunication'
        };
        if (calleeReason) calleeMessage.message = calleeReason;
        callee.sendMessage(calleeMessage);
    }

    var callee = userRegistry.getById(calleeId);
    if (!from || !userRegistry.getByName(from)) {
        return onError(null, 'unknown from = ' + from);
    }
    var caller = userRegistry.getByName(from);

    if (callResponse === 'accept') {
        var pipeline = new CallMediaPipeline();
        pipelines[caller.id] = pipeline;
        pipelines[callee.id] = pipeline;

        pipeline.createPipeline(caller.id, callee.id, ws, function(error) {
            if (error) {
                return onError(error, error);
            }

            pipeline.generateSdpAnswer(caller.id, caller.sdpOffer, function(error, callerSdpAnswer) {
                if (error) {
                    return onError(error, error);
                }

                pipeline.generateSdpAnswer(callee.id, calleeSdp, function(error, calleeSdpAnswer) {
                    if (error) {
                        return onError(error, error);
                    }

                    var message = {
                        id: 'startCommunication',
                        sdpAnswer: calleeSdpAnswer
                    };
                    callee.sendMessage(message);

                    message = {
                        id: 'callResponse',
                        response : 'accepted',
                        sdpAnswer: callerSdpAnswer
                    };
                    caller.sendMessage(message);

                    pipeline.record();
                });
            });
        });
    } else {
        var decline = {
            id: 'callResponse',
            response: 'rejected',
            message: 'user declined'
        };
        caller.sendMessage(decline);
    }
}

function call(callerId, to, from, sdpOffer) {
    clearCandidatesQueue(callerId);

    var caller = userRegistry.getById(callerId);
    var rejectCause = 'User ' + to + ' is not registered';
    if (userRegistry.getByName(to)) {
        var callee = userRegistry.getByName(to);
        caller.sdpOffer = sdpOffer
        callee.peer = from;
        caller.peer = to;
        var message = {
            id: 'incomingCall',
            from: from
        };
        try{
            return callee.sendMessage(message);
        } catch(exception) {
            rejectCause = "Error " + exception;
        }
    }
    var message  = {
        id: 'callResponse',
        response: 'rejected: ',
        message: rejectCause
    };
    caller.sendMessage(message);
}

function register(id, name, ws, callback) {
    function onError(error) {
        ws.send(JSON.stringify({id:'registerResponse', response : 'rejected ', message: error}));
    }

    if (!name) {
        return onError("empty user name");
    }

    if (userRegistry.getByName(name)) {
        return onError("User " + name + " is already registered");
    }

    userRegistry.register(new UserSession(id, name, ws));
    try {
        ws.send(JSON.stringify({id: 'registerResponse', response: 'accepted'}));
    } catch(exception) {
        onError(exception);
    }
}

function clearCandidatesQueue(sessionId) {
    if (candidatesQueue[sessionId]) {
        delete candidatesQueue[sessionId];
    }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);
    var user = userRegistry.getById(sessionId);

    if (pipelines[user.id] && pipelines[user.id].webRtcEndpoint && pipelines[user.id].webRtcEndpoint[user.id]) {
        var webRtcEndpoint = pipelines[user.id].webRtcEndpoint[user.id];
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        if (!candidatesQueue[user.id]) {
            candidatesQueue[user.id] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

function onPlayIceCandidate(sessionId, _candidate) {
    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);
    var user = userRegistry.getById(sessionId);

    if (playPipelines[user.id] && playPipelines[user.id].webRtcEndpoint && playPipelines[user.id].webRtcEndpoint[user.id]) {
        var webRtcEndpoint = playPipelines[user.id].webRtcEndpoint[user.id];
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        if (!candidatesQueue[user.id]) {
            candidatesQueue[user.id] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
