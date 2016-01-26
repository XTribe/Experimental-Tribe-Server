/*

  MHS - Message Handling Server
  
  Represent the system which keeps connected all game clients
  and transmit to and from the manager.
  
  Depending from the game, MHS will know to which manager address his communications.  
*/

var Http    = require('http')
  , Sockjs  = require('sockjs')
  , Pubsub  = require('pubsub')
  , Logger  = require('logger')
  , Manager = require('manager')
  , Url     = require('url')
  , Qs      = require('querystring')
  , Stash   = require('stash')
  , Step    = require('step')
  , Tools   = require('tools')
  , Experiments = require('experiment')
  , Crypto  = require("crypto")
  , Client  = require("client").Client
  , Instance = require('instance')

// cfg contains configuration parameter taken from ets config.json (currently located in ets/conf/config.json)
var cfg = require('config').read();

var startedAt = Date.now();

const C_SYSTEM = 'system';
const C_CLIENT = 'client';

var Clients = {};

var stats = {
  service: 'MHS',
  uptime: {
    label: 'Uptime (seconds)',
    value: Math.ceil((Date.now() - startedAt) / 1000)
  },
  connectedClients: {
    label: 'Connected clients',
    value: 0
  },
  receivedMessages: {
    label: 'Received messages',
    value: 0
  },
}

var server1
  , server2
  , pub
  , log
  , stash
  , sockjs;

function main() {
  
  pub = Pubsub.createClient(!cfg.services.redis.enabled);
  log = Logger.createClient('MHS');
  stash = Stash.createClient();
  
  var port1 = Tools.endpointGetPort(cfg.services.mhs.endpoint),
      port2 = Tools.endpointGetPort(cfg.services.mhs.endpoint2);

  log.info("Starting MHS (" + port1 + " & " + port2 + ")");
  
  var site = Url.parse(cfg.services.site.endpoint);
  if (!site.protocol) {
    site = Url.parse("http://" + cfg.services.site.endpoint);
  }

  /* Server on which communication of the managers are received. */
  server2 = Http.createServer();
  server2.listen(port2);
  
  /* Statistics publisher */
  if (cfg.services.stats.enabled) {
    setInterval(function() {
      stats.uptime.value = Math.ceil((Date.now() - startedAt) / 1000);
      pub.publish(Pubsub.channels.STATS, stats);
    }, cfg.services.stats.interval * 1000);
  }

  sockjs = Sockjs.createServer(); 
  server1 = Http.createServer();
  sockjs.installHandlers(server1, {
    prefix:'/mhs',
    sockjs_url: "http://cdn.sockjs.org/sockjs-0.3.min.js",
    log: function() {}
  });
  server1.listen(port1, '0.0.0.0');
  
  MgrTools.connection = sockjs;
  MgrTools.pubsub = pub;
  
  var i;

  // Client connection
  sockjs.on('connection', function(socket) {

    var client = new Client(socket);

    if (!Clients[socket.id]) {
      Clients[socket.id] = client;
    }

    stats.connectedClients.value++;
    
    // Messages from the client
    socket.on('data', function(data) {

      //log.verbose("RECEIVED MEX FROM CLIENT: "+JSON.stringify(data));

      stats.receivedMessages.value++;

      var msgIn;

      try {
        msgIn = JSON.parse(data);
      } catch(e) {
        log.warn("Unexpected input from client (invalid JSON)");
        socket.close();
        delete Clients[socket.id];      
        return;
      }

      if (msgIn.topic != 'ready' &&
          msgIn.topic != 'forward' &&
          msgIn.topic != 'dbg_create' &&
          msgIn.topic != 'over' /*&&
          msgIn.topic != 'userdata' && 
          msgIn.topic != 'my_userdata'*/) {
        client.sendError("Unrecognized system topic (" + msgIn.topic + ")", log);
        return;
      }

      // dm('client', 'me', msgIn.topic + (msgIn.topic == 'forward' ? ' ' + (Tools.isDef(msgIn.params.topic) ? msgIn.params.topic : '') : ''));

      // Use this message to create a bogus instance bypassing the ETS (for debugging purposes)
      if (msgIn.topic == 'dbg_create') {
        Instance.remove(msgIn.instance.id, function() {
          Instance.save(msgIn.instance);
          Experiments.saveData({
            "eId":           msgIn.instance.eId,
            "exactNUsers":   2,
            "anonymousJoin": true,
            "canPerform":    true,
            "managerURI":    msgIn.managerURI,
            "town": { 'name': "Pisa", 'lat': 0.0,'lng':0.0,'rad':0}
          });
          client.send({topic: "dbg_created"});
          socket.close();
          delete Clients[socket.id];
        });
        return;
      }
      
      var eId  = msgIn.eId
        , iId  = msgIn.iId
        , uId  = msgIn.uId
        , guid = msgIn.guid
        , instance;

      /* Saves session for logged user.
      The key of every active session is instanceid=guid, because the same player
      can join several instances. It is not possible for a player to join two times the same instance. */

      Sessions.set(iId, guid, client.socket.id, uId);

      Instances.get(iId, function(err, instance) {

        if (!instance) {
          client.sendError("Unable to retrieve instance data", log);
          return;
        }

        // Verify the user is one of those registered to the instance
        if (-1 === instance.users.map(function(u) { return u.guid }).indexOf(guid)) {
          client.sendError("You are not part of this instance", log);
          return;
        }

        // Any message on a terminated experiment, produce an error
        if (instance.ended) {
          client.sendError("Cannot restart an ended experiment", log);
          return;
        }
        
        Experiments.get(site, eId, function(error, experiment) {
          
          //log.verbose("Experiments.get msgIn: "+JSON.stringify(msgIn));

          if (error) {
            client.sendError("Error while retrieving experiment data (" + error + ")", log);
            return;
          }
  
          // Data needed at the time of the disconnection
          client.set('iId', instance.id);
          client.set('eId', experiment.eId);
          client.set('uId', uId);
          
          // Find (or create) connection to the manager for our instance
          var gw = MgrTools.findGateway(experiment, iId);

          var msgOut = {
            clientId:   guid, // The manager will use it as unambiguos id of the user
            userId:     MgrTools.getHashedUid(uId),  // Generate an hash of the uid for use of the manager
            instanceId: iId,  // instance ID is a value that can be passed to the manager
            experiment: {
              id: eId,
              town: experiment.data.town
            }
          };

          if ('forward' == msgIn.topic) {
            // Message to be delivered as a in-experiment message
            msgOut.sender = C_CLIENT;
            msgOut.topic  = msgIn.params.topic;
            msgOut.params = msgIn.params.params;
          } else {
            msgOut.sender = C_SYSTEM;
            msgOut.topic  = msgIn.topic;
            msgOut.params = msgIn.params;
          }

          // Along with ready message, userdata have to be sent
          if ('ready' == msgIn.topic) {
            // Save the state of the instance so we publish the READY channel one time only
            if (!instance.started) {
              pub.publish(Pubsub.channels.INSTANCE_READY, {
                 eId: instance.eId,
                 uId: instance.users.map(function(u) { return u.uId }),
                 guid: instance.users.map(function(u) { return u.guid }),
                 iId: instance.id,
                 site: site});
              Instances.setStarted(instance, true);
            }
            
            // From the instance user array, filter the user who sent the request and give back ONLY his own data
            if (experiment.data.userdata_sending=="1") {
                var userdataToReturn = instance.users.filter(function(u) {
                if (String(msgIn.guid)==String(u.guid)) {
                  return true;
                }else{
                  return false;
                }
              });
              userdataToReturn=userdataToReturn[0];
              // Remove uid from data that are to be sent (security sake)
              delete userdataToReturn["guid"];
              delete userdataToReturn["uId"];
              delete userdataToReturn["data"]["uId"];

              // Usera Data gets filled inside ets_services_user_info in ets.services.inc
             msgOut.params = userdataToReturn;
            };
          }

          /* Messages 'over' coming directly from clients, just for the sake of simplicity get processed same way that if it came from the manager, in order to be processed
          and forwarded to all clients. Then it will be forwarded to manager too. (see subsequent gw.forward)*/
          if (msgIn.topic == 'over' /*|| msgIn.topic == 'my_userdata'*/) {
            var msgOutOver = msgIn;
            msgOutOver.recipient='system';
            msgOutOver.instanceId=msgIn.iId;
            e = MgrTools.processManagerMessage(instance, msgIn, site);
          }

          // Forward the message to the manager and receive manager's response
          // as an array of messages
          // log.verbose("forwarding "+JSON.stringify(msgOut));
          gw.forward(msgOut, function(err, messages) {
            if (err) {
              client.sendError("Error communicating with the experiment manager (" + err + ")", log);
              return;
            }
  
            for (var i=0; i < messages.length; i++) {
              e = MgrTools.processManagerMessage(instance, messages[i], site);
              if (e != '') {
                log.error("Error processing message from manager: " + e);
                client.sendError(e, log);
                return;
              }
            }
          });
          
        }); // get experiment
      }); // Instances.get
    }); // on Data
    
    socket.on('close', function() {

//      log.info("Client disconnected");

      var instance
        , uId
        , iId
        , eId
        , sess = Sessions.get(client.socket.id);

      if (!sess) {
        return;
      }

      Step(
        
        function() {
          uId = client.get('uId');
          iId = client.get('iId');
          eId = client.get('eId');
          Instances.get(iId, this);
        }
        
        ,
        
        function(err, data) {
          instance = data;
          Experiments.get(site, eId, this);
        }
        
        ,
        
        function(err, data) {

          if (err || !instance) return;

          // Send to the manager END or ABORT depending if the instance is finished or not
          var msgOut = {
            sender:     C_SYSTEM,
            topic:      instance.ended ? 'end' : 'abort',
            clientId:   sess.guid,
            userId:     MgrTools.getHashedUid(uId),
            instanceId: instance.id, 
            experiment: {
              id:   data.eId,
              town: data.data.town
            }
          };

          // Tell an 'abort' to the other connected clients
          if (!instance.ended) {
            MgrTools.broadcast(instance, {topic: 'abort'}, client.socket.id);
          }
          
          var gw = MgrTools.findGateway(data, instance.id);
          if (gw) {
            gw.forward(msgOut, function() { /* No return data needed */ });
          }

          /* If a client disconnects, we consider the instance terminated.
      	  In the future, it will not be always true, for, when a user disconnects, 
      	  a bot or a pending player could replace him.  */
      		
      	  // Publishing instance_disconnects in case the user disconnects before concluding the game. 
          // Without this message statistic cannot distinguish if the instance is still alive or dropped
      	  if (!instance.ended) {
            pub.publish(Pubsub.channels.INSTANCE_ERROR, {
          		eId: data.eId, 
          		iId: instance.id,
          		uId: MgrTools.getHashedUid(uId), 
          		guid: sess.guid,
          		site: site
            });
          }  

          Instances.setEnded(instance, true)
        }
      )

      Sessions.del(client.socket.id);
      delete Clients[client.socket.id];      
    });

  }); // Channel connection

  /* @TODO
   * Messages can arrive as a response to a request or directly from the manager
   */
  server2.on('request', function(req, res) {
    
    var chunks = [];

    req.setEncoding('utf8');

    req.on('data', function (chunk) {
      chunks.push(chunk.toString());
    });

    req.on('end', function () {
      
      var data = Qs.parse(chunks.join())
        , message;
        
      // Here we get different paths depending on which subject contacted us
      // (could be a manager, or anyone asking us to act as the "default manager")

      res.writeHead(200, JSON.stringify("OK"), {'Content-Type': 'application/json'});

      if (data.message) {

        message = JSON.parse(data.message);

        // Discard SYSTEM messages
        if (message.sender == C_CLIENT) {

          // Find the instance this message belongs to and broadcast the message to
          // everyone in the instance
          Instances.get(message.instanceId, function(err, instance) {

            if (err) {
              return;
            }

            // Brrrroadcast!
            var session = Sessions.find(instance.id, message.clientId);
            MgrTools.broadcast(instance, {topic: 'forward',
                                            params: {
                                              topic: message.topic,
                                              params: message.params
                                            }
                                          },
                                          session ? session.socketId : null);
            
          })
        }
      }
        
      /*
      try {
        message = JSON.parse(data);
        res.writeHead(200, JSON.stringify("OK"), {'Content-Type': 'application/json'});
        res.write(JSON.stringify("1")); // Just to say "OK"
        processManagerMessage(message, io);
      } catch (e) {
        res.writeHead(500, JSON.stringify("Internal server error"), {'Content-Type': 'application/json'});
      }
      */

      res.end();
    });

  });
}

// Model that manages every session inside instances
// Keeps association between sessionId and userId
var Sessions = {
  
  // Index on instance ("Which users and sessions for a certain instance?")
  sessions: {},
  
  // Index for lookup for the get() ("Which instance and user for a certain session?")
  sessions_idx: {},
  
  reset: function() {
    this.sessions = {};
    this.sessions_idx = {};
  },
  
  // Creates a session object, or updates an existent one
  set: function(iId, guid, socketId, uId) {

    if (typeof this.sessions["i" + iId] == 'undefined') {
      // Tutte le sessioni di questo instance
      this.sessions["i" + iId] = []
    }
    var s = this.find(iId, guid);
    if (!s) {
      this.sessions["i" + iId][this.sessions["i" + iId].length] = {guid: guid, socketId: socketId, uId: uId};
    } else {
      s.socketId = socketId;
    }
    
    this.sessions_idx[socketId] = {
      guid: guid,
      iId: iId
    };
  },
  
  // Retrieve a session object from memory given the instance id and the user id
  find: function(iId, guid) {
    if (!this.sessions["i" + iId] || this.sessions["i" + iId].length === 0) {
      return null;
    }
    var s = this.sessions["i" + iId]
      , l = s.length;
      
    for (var i = 0; i < l; i++) {
      if (s[i].guid == guid) {
        return s[i];
      }
    }
    return null;
  },
  
  // Return uId and iId given the session id
  get: function(sId) {
    if (typeof this.sessions_idx[sId] == 'undefined') {
      return null;
    }
    return {
      guid: this.sessions_idx[sId].guid,
      iId: this.sessions_idx[sId].iId
    }
  },
  
  // Return all the session of a given instance
  all: function(iId) {
    return this.sessions["i" + iId] || [];
  },

  // Remove a session from memory
  del: function(sId) {
    var self = this;
    this.instances().forEach(function(key) {
      for (var i = 0; i < self.sessions[key].length; i++) {
        if (sId == self.sessions[key][i].socketId) {
          self.sessions[key].splice(i,1);
          break;
        }
      }
      if (0 == self.sessions[key].length) {
        delete self.sessions[key];
      }
    });
    delete this.sessions_idx[sId];
  },
  
  instances: function() {
    return Object.keys(this.sessions)
  }
}

exports.Sessions = Sessions;

var MgrTools = {
  
  gateways: [],
  
  /* We use a property and not the global variable for we can 
  create a mock to use for tests */
  conn: null,
  
  // The pubsub: for tests it can be disabled
  pub: null,

  // Cache for hashed uId
  hashedUids: {},
  
  set connection(value) {
    this.conn = value;
  },
  
  set pubsub(value) {
    this.pub = value;
  },
  
  /* Validation of a message by manager
  Returns an error message or an empty string
  */
  validateManagerMessage: function(message) {

    if (!Tools.isObject(message)) {
      return "Invalid message from manager (not an object)";
    }
      
    if (!Tools.isDef(message.topic)) {
      return "Unknown message from manager (no topic)";
    }

    if (!Tools.isDef(message.recipient)) {
      return "Invalid message from manager (no recipient)";
    }
  
    if (message.recipient != C_SYSTEM && message.recipient != C_CLIENT) {
      return "Invalid message from manager (wrong recipient " + message.recipient + ")";
    }
        
    if (!message.instanceId) {
      return "Invalid message from manager (no instanceId)";
    }
  
    /*
    if (!Instances.get(message.instanceId, false)) {
      return "Invalid message from manager (invalid instanceId)";
    }
    */
    
    return '';
  },
  
  processManagerMessage: function(instance, message, site) {

    // log.verbose("RECEIVED MEX FROM MANAGER: "+JSON.stringify(message));

    if (Tools.isEmpty(message)) {
      return '';
    }

    var v = this.validateManagerMessage(message);

    if (v != '') {
      return v;
    }
    
    //dm('manager', 'me', message.topic + " [" + message.recipient + "]");
    
    // Controls must have been done during validation
    var i
      , s;

    /* Management of the reply message from the manager */
    switch (message.recipient) {
      
      case C_CLIENT:
        // log.verbose("MESSAGE CLIENT "+message.topic);
        // userId is our guid
        s = Sessions.find(message.instanceId, message.clientId);
        if (!s) {
          return "Cannot find the session for the user";
        }
        
        //dm('me', 'client', 'forward [' + message.topic + ']'  + (message.broadcast ? ' (broadcast)' : ''));
        
        // Params for the FORWARD message
        var params = {
          topic: message.topic,
          params: message.params
        }
        
        if (message.broadcast) {
          // If a final parameter gets added, that session will be excluded
          this.broadcast(instance, {topic: 'forward', params: params || null}, message.includeSelf ? null : s.socketId);
        } else {
          //  Send the message to the client that originated it
          Clients[s.socketId].send({topic: 'forward', params: params || null});
        }
        
        break;
      
      case C_SYSTEM:

        // At the moment Only the over "system" message can ben sent by a manager and over from clients.
        switch (message.topic) {
          // The client is asking to the system for his *own* userdata
          /*case 'my_userdata': 
            s = Sessions.find(message.instanceId, message.guid);
            if (!s) {
              //return "Cannot find the session for the user";
            }

            // From the instance user array, filter the user who sent the request and give back ONLY his own data
            var userdataToReturn = instance.users.filter(function(u) {
              if (String(message.guid)==String(u.guid)) {
                return true;
              }else{
                return false;
              }
            });
            userdataToReturn=userdataToReturn[0];
            // Remove uid from data that are to be sent (security sake)
            delete userdataToReturn["uId"];
            delete userdataToReturn["data"]["uId"];

            // 'Data' gets filled inside ets_services_user_info in ets.services.inc
            var msgOut = {
              sender:     C_SYSTEM,
              topic:      'my_userdata',
              instanceId: instance.id, 
              eId:   instance.eId,
              params: userdataToReturn
            };

            // Sending back the message to the client
            Clients[s.socketId].send(msgOut);            
            break;
          */

          // The manager is asking to the system some userdata
          /*case 'userdata':
            if (String(message.instanceId)==String(instance.id)) {
              // From the instance user array, filter data in order not to pass uid (security sake)
              var userdataToReturn = instance.users.map(function(u) {
                var a={}
                a["guid"]=u.guid;
                a["data"]=u.data;
                delete a["data"]["uId"];
                return a;
              });

              // 'Data' gets filled inside ets_services_user_info in ets.services.inc
              var msgOut = {
                sender:     C_SYSTEM,
                topic:      'userdata',
                instanceId: instance.id, 
                eId:   instance.eId,
                params: userdataToReturn
              };
            }else{
              // TODO: how to send error on a wrong request
              return "Invalid message from manager (wrong instanceId)";
            }

            // Sends to manager as a system message
            var experiment = Experiments.retrieve(instance.eId, true);
            var gw = MgrTools.findGateway(experiment, instance.id);
            if (gw) {
                gw.forward(msgOut, function(err, messages) {
                  if (err) {
                    client.sendError("Error communicating with the experiment manager (" + err + ")", log);
                    return;
                  }
                  for (var i=0; i < messages.length; i++) {
                    e = MgrTools.processManagerMessage(instance, messages[i], site);
                    if (e != '') {
                      log.error("Error processing message from manager: " + e);
                      client.sendError(e, log);
                      return;
                    }
                  }
              });
            }
            
            break;
            */
          case 'over':
            // broadcast to all clients
            this.broadcast(instance, {
              // clientId: message.clientId, 
              // instanceId: message.instanceId, 
              // experiment: message.experiment, 
              sender:'system', 
              topic: 'over', 
              params: message.params || null});

            // The score could be a single value or an hash indexed on the user id
            var score = '', to, sess;

            ['score', 'scores'].forEach(function(k) {
               to = typeof message[k];
               if (to !== 'undefined') {
                 // Score can be encoded in two way:
                 // - you can specify a single, float value and it will be used for every user in the experiment
                 // - you can specify an hash like: "clientId" => "score"; this will be passed to drupal in the form: "uid1:score1;uid2:score1;uid3:score3..."
                 //   Note that if users are anonymous you'll have "0:score1;0:score2..."
                 if (to === 'string' || to === 'number') {
                   score = message[k];
                 } else {
                   // Score is an object and must be encoded
                   // What for managers is the clientId, for mhs is the guid
                   for (guid in message[k]) {
                     sess = Sessions.find(instance.id, guid);
                     if (sess) {
                       score += sess.uId + ":" + message[k][guid] + ";";
                     }
                   }
                 }
               }
            });

            if (this.pub) {
              // Collect every user in the instance and update their stats
              pub.publish(Pubsub.channels.INSTANCE_OVER, {
                  eId: instance.eId
                , score: score
                , site: site
                , iId: instance.id
		            , uId: instance.users.map(function(u) { return u.uId })
		            , guid: instance.users.map(function(u) { return u.guid })
              });
            }
           
            //Instances.setEnded(instance, true);

            break;
          
        }
        
        break;
      
    }
    
    return ''; // OK
  },
  
  // FIXME error: the gateway is at the level of the experiment, not of the single instance!
  findGateway: function(experiment, iId) {

    if (!experiment || !iId) {
      // Just for test; it'll never happen
      log.error("Need more data (1)");
      return null;
    }

    if (!Tools.isDef(experiment.data)) {
      // Just for test; it should never happen
      log.error("Need more data (2)");
      return null;
    }

    for (var i=0; i < this.gateways.length; i++) {
      if (this.gateways[i].instanceId == iId) {
        return this.gateways[i];
      }
    }

    var parts = Url.parse(experiment.data.managerURI);

    // Gateway does not exist, just create it
    var gw = new ManagerGateway();

    gw.instanceId = iId;
    gw.endPoint = parts.pathname;
    // FIXME: HTTPS and authentication test
    gw.client = Manager.createClient((parts.auth ? (parts.auth + "@") : '' ) + parts.hostname, parts.port);

    this.gateways.push(gw);

    return gw;
  },

  broadcast: function(instance, message, exclude) {
    var s = Sessions.all(instance.id)
      , socket;

    for (var i = 0; i < s.length; i++) {
      if (!exclude || exclude != s[i].socketId) {
        Clients[s[i].socketId] && Clients[s[i].socketId].send(message);
        
        // In case of over, the message should be sended to manager too. The above code sent message to
        // clients but not to manager. The underlying code sends to manager, too.
        if(message.topic=='over'){
          var msgOut = {
            sender:     C_SYSTEM,
            topic:      'over',
            instanceId: instance.id
          };
          var experiment = Experiments.retrieve(instance.eId, true);
          var gw = MgrTools.findGateway(experiment, instance.id);
          if (gw) {
            gw.forward(msgOut, function() { });
          }
        }
      }
    }
  },
  
  getHashedUid: function(uId) {

    if (uId === 0) {
      return 0;
    }
    
    if ('undefined' === typeof this.hashedUids[uId]) {
      return this.hashedUids[uId] = Crypto.createHash('md5').update( uId + cfg.ets_key ).digest("hex")
    } else {
      return this.hashedUids[uId];
    }
  },

  getUidFromHash: function(hash) {

    if (hash === 0) {
      return 0;
    }

    for (uId in this.hashedUids) {
      if (this.hashedUids[uId] === hash) {
        return uId;
      }
    }

    return null;
  }
  
}

var ManagerGateway = function() {
  this.instanceId = null;
  this.endPoint   = null;
  this.client = null;
}

ManagerGateway.prototype.forward = function(msgOut, cb) {
  if (this.client) {
    this.client.post(this.endPoint, msgOut, cb);
  }
}

// Object managing instances finding and updating from/to the stash
// TODO verify the possibility to use the Instance object (already in scope)
var Instances = {
  
  get: function (iId, cb) {
    stash.get('instance_' + iId, cb)
  }
  
  ,
  
  setEnded: function (instance, value, cb) {
    
    instance.ended = value
    
    stash.set('instance_' + instance.id, instance, cb)
    
  },

  setStarted: function (instance, value, cb) {
    
    instance.started = value
    
    stash.set('instance_' + instance.id, instance, cb)
    
  }

}

/* Exported for test purposes */
exports.Instances = Instances;
exports.MgrTools = MgrTools;

// Debug Message
function dm(from, dest, str) {
  if (!log) {
    return;
  }

// console.log(GET RID OF THIS RETURN);  
// return;

  switch (true) {

    case (dest == 'me' && from == 'client'):
      log.verbose("From "+from+" to "+dest+": ===> [" + str + "]");
      break;

    case (dest == 'client' && from == 'me'):
      log.verbose("From "+from+" to "+dest+": <=== [" + str + "]");
      break;
      
    case (dest == 'manager' && from == 'me'):
      log.verbose("From "+from+" to "+dest+":      [" + str + "] ===>");
      break;
      
    case (dest == 'me' && from == 'manager'):
      log.verbose("From "+from+" to "+dest+":      [" + str + "] <===");
      break;
      
    default:
      log.verbose("===> ??? <===");
      break;
  }
}

if (require.main === module) {
  main()
  Tools.changeProcessOwnership(cfg);
} else {
  exports.main = main;
}
