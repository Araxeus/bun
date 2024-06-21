const net = require("node:net");
const dgram = require("node:dgram");
const EventEmitter = require("node:events");

const { ErrnoException } = require("internal/errors");
const { SocketListSend, SocketListReceive } = require("internal/socket_list");
const { kStateSymbol } = require("internal/dgram");
const {
  WriteWrap,
  streamBaseState,
  kReadBytesOrError,
  kArrayBufferOffset,
  kLastWriteWasAsync,
} = require("internal/child_process/write_wrap");
const serialization = require("internal/child_process/serialization");

const ERR_IPC_CHANNEL_CLOSED = $zig("node_error_binding.zig", "ERR_IPC_CHANNEL_CLOSED");
const ERR_INVALID_HANDLE_TYPE = $zig("node_error_binding.zig", "ERR_INVALID_HANDLE_TYPE");
const ERR_IPC_DISCONNECTED = $zig("node_error_binding.zig", "ERR_IPC_DISCONNECTED");
const ERR_MISSING_ARGS = $zig("node_error_binding.zig", "ERR_MISSING_ARGS");
const ERR_INVALID_ARG_TYPE = $zig("node_error_binding.zig", "ERR_INVALID_ARG_TYPE");

const FunctionPrototype = Function.prototype;
const ArrayIsArray = Array.isArray;
const ArrayPrototypePush = Array.prototype.push;
const StringPrototypeSlice = String.prototype.slice;

const MAX_HANDLE_RETRANSMISSIONS = 3;
const kChannelHandle = Symbol("kChannelHandle");
const kPendingMessages = Symbol("kPendingMessages");
const nop = FunctionPrototype;

function setupChannel(target, channel, serializationMode) {
  const control = new Control(channel);
  target.channel = control;
  target[kChannelHandle] = channel;

  target._handleQueue = null;
  target._pendingMessage = null;

  const { initMessageChannel, parseChannelMessages, writeChannelMessage } = serialization[serializationMode];

  let pendingHandle = null;
  initMessageChannel(channel);
  channel.pendingHandle = null;
  channel.onread = function (arrayBuffer) {
    const recvHandle = channel.pendingHandle;
    channel.pendingHandle = null;
    if (arrayBuffer) {
      const nread = streamBaseState[kReadBytesOrError];
      const offset = streamBaseState[kArrayBufferOffset];
      const pool = new Uint8Array(arrayBuffer, offset, nread);
      if (recvHandle) pendingHandle = recvHandle;

      for (const message of parseChannelMessages(channel, pool)) {
        // There will be at most one NODE_HANDLE message in every chunk we
        // read because SCM_RIGHTS messages don't get coalesced. Make sure
        // that we deliver the handle with the right message however.
        if (isInternal(message)) {
          if (message.cmd === "NODE_HANDLE") {
            handleMessage(message, pendingHandle, true);
            pendingHandle = null;
          } else {
            handleMessage(message, undefined, true);
          }
        } else {
          handleMessage(message, undefined, false);
        }
      }
    } else {
      this.buffering = false;
      target.disconnect();
      channel.onread = nop;
      channel.close();
      target.channel = null;
      maybeClose(target);
    }
  };

  // Object where socket lists will live
  channel.sockets = { got: {}, send: {} };

  // Handlers will go through this
  target.on("internalMessage", function (message, handle) {
    // Once acknowledged - continue sending handles.
    if (message.cmd === "NODE_HANDLE_ACK" || message.cmd === "NODE_HANDLE_NACK") {
      if (target._pendingMessage) {
        if (message.cmd === "NODE_HANDLE_ACK") {
          closePendingHandle(target);
        } else if (target._pendingMessage.retransmissions++ === MAX_HANDLE_RETRANSMISSIONS) {
          closePendingHandle(target);
          process.emitWarning(
            "Handle did not reach the receiving process " + "correctly",
            "SentHandleNotReceivedWarning",
          );
        }
      }

      $assert(ArrayIsArray(target._handleQueue));
      const queue = target._handleQueue;
      target._handleQueue = null;

      if (target._pendingMessage) {
        target._send(
          target._pendingMessage.message,
          target._pendingMessage.handle,
          target._pendingMessage.options,
          target._pendingMessage.callback,
        );
      }

      for (let i = 0; i < queue.length; i++) {
        const args = queue[i];
        target._send(args.message, args.handle, args.options, args.callback);
      }

      // Process a pending disconnect (if any).
      if (!target.connected && target.channel && !target._handleQueue) target._disconnect();

      return;
    }

    if (message.cmd !== "NODE_HANDLE") return;

    // It is possible that the handle is not received because of some error on
    // ancillary data reception such as MSG_CTRUNC. In this case, report the
    // sender about it by sending a NODE_HANDLE_NACK message.
    if (!handle) return target._send({ cmd: "NODE_HANDLE_NACK" }, null, true);

    // Acknowledge handle receival. Don't emit error events (for example if
    // the other side has disconnected) because this call to send() is not
    // initiated by the user and it shouldn't be fatal to be unable to ACK
    // a message.
    target._send({ cmd: "NODE_HANDLE_ACK" }, null, true);

    const obj = handleConversion[message.type];

    // Update simultaneous accepts on Windows
    if (process.platform === "win32") {
      handle.setSimultaneousAccepts(false);
    }

    // Convert handle object
    obj.got.$call(this, message, handle, handle => {
      handleMessage(message.msg, handle, isInternal(message.msg));
    });
  });

  target.on("newListener", function () {
    process.nextTick(() => {
      if (!target.channel || !target.listenerCount("message")) return;

      const messages = target.channel[kPendingMessages];
      const { length } = messages;
      if (!length) return;

      for (let i = 0; i < length; i++) {
        target.emit.$apply(target, messages[i]);
      }

      target.channel[kPendingMessages] = [];
    });
  });

  target.send = function (message, handle, options, callback) {
    if (typeof handle === "function") {
      callback = handle;
      handle = undefined;
      options = undefined;
    } else if (typeof options === "function") {
      callback = options;
      options = undefined;
    } else if (options !== undefined) {
      validateObject(options, "options");
    }

    options = { swallowErrors: false, ...options };

    if (this.connected) {
      return this._send(message, handle, options, callback);
    }
    const ex = ERR_IPC_CHANNEL_CLOSED();
    if (typeof callback === "function") {
      process.nextTick(callback, ex);
    } else {
      process.nextTick(() => this.emit("error", ex));
    }
    return false;
  };

  target._send = function (message, handle, options, callback) {
    $assert(this.connected || this.channel);

    if (message === undefined) throw ERR_MISSING_ARGS("message");

    // Non-serializable messages should not reach the remote
    // end point; as any failure in the stringification there
    // will result in error message that is weakly consumable.
    // So perform a final check on message prior to sending.
    if (
      typeof message !== "string" &&
      typeof message !== "object" &&
      typeof message !== "number" &&
      typeof message !== "boolean"
    ) {
      throw ERR_INVALID_ARG_TYPE("message", "string, object, number, or boolean", message);
    }

    // Support legacy function signature
    if (typeof options === "boolean") {
      options = { swallowErrors: options };
    }

    let obj;

    // Package messages with a handle object
    if (handle) {
      // This message will be handled by an internalMessage event handler
      message = {
        cmd: "NODE_HANDLE",
        type: null,
        msg: message,
      };

      if (handle instanceof net.Socket) {
        message.type = "net.Socket";
      } else if (handle instanceof net.Server) {
        message.type = "net.Server";
        // } else if (handle instanceof TCP || handle instanceof Pipe) {
        //   message.type = "net.Native";
      } else if (handle instanceof dgram.Socket) {
        message.type = "dgram.Socket";
        // } else if (handle instanceof UDP) {
        //   message.type = "dgram.Native";
      } else {
        throw ERR_INVALID_HANDLE_TYPE();
      }

      // Queue-up message and handle if we haven't received ACK yet.
      if (this._handleQueue) {
        ArrayPrototypePush(this._handleQueue, {
          callback: callback,
          handle: handle,
          options: options,
          message: message.msg,
        });
        return this._handleQueue.length === 1;
      }

      obj = handleConversion[message.type];

      // convert TCP object to native handle object
      handle = handleConversion[message.type].send.$apply(target, [message, handle, options]);

      // If handle was sent twice, or it is impossible to get native handle
      // out of it - just send a text without the handle.
      if (!handle) message = message.msg;

      // Update simultaneous accepts on Windows
      if (obj.simultaneousAccepts && process.platform === "win32") {
        handle.setSimultaneousAccepts(true);
      }
    } else if (
      this._handleQueue &&
      !(message && (message.cmd === "NODE_HANDLE_ACK" || message.cmd === "NODE_HANDLE_NACK"))
    ) {
      // Queue request anyway to avoid out-of-order messages.
      ArrayPrototypePush(this._handleQueue, {
        callback: callback,
        handle: null,
        options: options,
        message: message,
      });
      return this._handleQueue.length === 1;
    }

    const req = new WriteWrap();

    const err = writeChannelMessage(channel, req, message, handle);
    const wasAsyncWrite = streamBaseState[kLastWriteWasAsync];

    if (err === 0) {
      if (handle) {
        if (!this._handleQueue) this._handleQueue = [];
        if (obj && obj.postSend) obj.postSend(message, handle, options, callback, target);
      }

      if (wasAsyncWrite) {
        req.oncomplete = () => {
          control.unrefCounted();
          if (typeof callback === "function") callback(null);
        };
        control.refCounted();
      } else if (typeof callback === "function") {
        process.nextTick(callback, null);
      }
    } else {
      // Cleanup handle on error
      if (obj && obj.postSend) obj.postSend(message, handle, options, callback);

      if (!options.swallowErrors) {
        const ex = new ErrnoException(err, "write");
        if (typeof callback === "function") {
          process.nextTick(callback, ex);
        } else {
          process.nextTick(() => this.emit("error", ex));
        }
      }
    }

    /* If the primary is > 2 read() calls behind, please stop sending. */
    return channel.writeQueueSize < 65536 * 2;
  };

  // Connected will be set to false immediately when a disconnect() is
  // requested, even though the channel might still be alive internally to
  // process queued messages. The three states are distinguished as follows:
  // - disconnect() never requested: channel is not null and connected
  //   is true
  // - disconnect() requested, messages in the queue: channel is not null
  //   and connected is false
  // - disconnect() requested, channel actually disconnected: channel is
  //   null and connected is false
  target.connected = true;

  target.disconnect = function () {
    if (!this.connected) {
      this.emit("error", ERR_IPC_DISCONNECTED());
      return;
    }

    // Do not allow any new messages to be written.
    this.connected = false;

    // If there are no queued messages, disconnect immediately. Otherwise,
    // postpone the disconnect so that it happens internally after the
    // queue is flushed.
    if (!this._handleQueue) this._disconnect();
  };

  target._disconnect = function () {
    $assert(this.channel);

    // This marks the fact that the channel is actually disconnected.
    this.channel = null;
    this[kChannelHandle] = null;

    if (this._pendingMessage) closePendingHandle(this);

    let fired = false;
    function finish() {
      if (fired) return;
      fired = true;

      channel.close();
      target.emit("disconnect");
    }

    // If a message is being read, then wait for it to complete.
    if (channel.buffering) {
      this.once("message", finish);
      this.once("internalMessage", finish);

      return;
    }

    process.nextTick(finish);
  };

  function emit(event, message, handle) {
    if ("internalMessage" === event || target.listenerCount("message")) {
      target.emit(event, message, handle);
      return;
    }

    ArrayPrototypePush.$apply(target.channel[kPendingMessages], [[event, message, handle]]);
  }

  function handleMessage(message, handle, internal) {
    if (!target.channel) return;

    const eventName = internal ? "internalMessage" : "message";

    process.nextTick(emit, eventName, message, handle);
  }

  channel.readStart();
  return control;
}

const INTERNAL_PREFIX = "NODE_";
function isInternal(message) {
  return (
    message !== null &&
    typeof message === "object" &&
    typeof message.cmd === "string" &&
    message.cmd.length > INTERNAL_PREFIX.length &&
    StringPrototypeSlice.$apply(message.cmd, [0, INTERNAL_PREFIX.length]) === INTERNAL_PREFIX
  );
}

function maybeClose(subprocess) {
  subprocess._closesGot++;

  if (subprocess._closesGot === subprocess._closesNeeded) {
    subprocess.emit("close", subprocess.exitCode, subprocess.signalCode);
  }
}

function closePendingHandle(target) {
  target._pendingMessage.handle.close();
  target._pendingMessage = null;
}

function validateObject(value, name, options?) {
  // const validateObject = hideStackFrames((value, name, options = null) => {
  const allowArray = options?.allowArray ?? false;
  const allowFunction = options?.allowFunction ?? false;
  const nullable = options?.nullable ?? false;
  if (
    (!nullable && value === null) ||
    (!allowArray && $isJSArray(value)) ||
    (typeof value !== "object" && (!allowFunction || typeof value !== "function"))
  ) {
    throw ERR_INVALID_ARG_TYPE(name, "object", value);
  }
}

//
//

// Lazy loaded for startup performance and to allow monkey patching of
// internalBinding('http_parser').HTTPParser.
let freeParser;
let HTTPParser;

// This object contain function to convert TCP objects to native handle objects
// and back again.
const handleConversion = {
  // "net.Native": {
  //   simultaneousAccepts: true,

  //   send(message, handle, options) {
  //     return handle;
  //   },

  //   got(message, handle, emit) {
  //     emit(handle);
  //   },
  // },

  "net.Server": {
    simultaneousAccepts: true,

    send(message, server, options) {
      return server._handle;
    },

    got(message, handle, emit) {
      const server = new net.Server();
      server.listen(handle, () => {
        emit(server);
      });
    },
  },

  "net.Socket": {
    send(message, socket, options) {
      if (!socket._handle) return;

      // If the socket was created by net.Server
      if (socket.server) {
        // The worker should keep track of the socket
        message.key = socket.server._connectionKey;

        const firstTime = !this[kChannelHandle].sockets.send[message.key];
        const socketList = getSocketList("send", this, message.key);

        // The server should no longer expose a .connection property
        // and when asked to close it should query the socket status from
        // the workers
        if (firstTime) socket.server._setupWorker(socketList);

        // Act like socket is detached
        if (!options.keepOpen) socket.server._connections--;
      }

      const handle = socket._handle;

      // Remove handle from socket object, it will be closed when the socket
      // will be sent
      if (!options.keepOpen) {
        handle.onread = nop;
        socket._handle = null;
        socket.setTimeout(0);

        // if (freeParser === undefined) freeParser = require("_http_common").freeParser;
        // if (HTTPParser === undefined) HTTPParser = require("_http_common").HTTPParser;

        // // In case of an HTTP connection socket, release the associated
        // // resources
        // if (socket.parser && socket.parser instanceof HTTPParser) {
        //   freeParser(socket.parser, null, socket);
        //   if (socket._httpMessage) socket._httpMessage.detachSocket(socket);
        // }
      }

      return handle;
    },

    postSend(message, handle, options, callback, target) {
      // Store the handle after successfully sending it, so it can be closed
      // when the NODE_HANDLE_ACK is received. If the handle could not be sent,
      // just close it.
      if (handle && !options.keepOpen) {
        if (target) {
          // There can only be one _pendingMessage as passing handles are
          // processed one at a time: handles are stored in _handleQueue while
          // waiting for the NODE_HANDLE_ACK of the current passing handle.
          $assert(!target._pendingMessage);
          target._pendingMessage = { callback, message, handle, options, retransmissions: 0 };
        } else {
          handle.close();
        }
      }
    },

    got(message, handle, emit) {
      const socket = new net.Socket({
        handle: handle,
        readable: true,
        writable: true,
      });

      // If the socket was created by net.Server we will track the socket
      if (message.key) {
        // Add socket to connections list
        const socketList = getSocketList("got", this, message.key);
        socketList.add({
          socket: socket,
        });
      }

      emit(socket);
    },
  },

  // "dgram.Native": {
  //   simultaneousAccepts: false,

  //   send(message, handle, options) {
  //     return handle;
  //   },

  //   got(message, handle, emit) {
  //     emit(handle);
  //   },
  // },

  "dgram.Socket": {
    simultaneousAccepts: false,

    send(message, socket, options) {
      message.dgramType = socket.type;

      return socket[kStateSymbol].handle;
    },

    got(message, handle, emit) {
      const socket = new dgram.Socket(message.dgramType);

      socket.bind(handle, () => {
        emit(socket);
      });
    },
  },
};

function getSocketList(type, worker, key) {
  const sockets = worker[kChannelHandle].sockets[type];
  let socketList = sockets[key];
  if (!socketList) {
    const Construct = type === "send" ? SocketListSend : SocketListReceive;
    socketList = sockets[key] = new Construct(worker, key);
  }
  return socketList;
}

class Control<T> extends EventEmitter {
  #channel: T;
  #refs = 0;
  #refExplicitlySet = false;
  [kPendingMessages] = [];

  constructor(channel: T) {
    super();
    this.#channel = channel;
  }

  // The methods keeping track of the counter are being used to track the
  // listener count on the child process object as well as when writes are
  // in progress. Once the user has explicitly requested a certain state, these
  // methods become no-ops in order to not interfere with the user's intentions.
  refCounted() {
    if (++this.#refs === 1 && !this.#refExplicitlySet) {
      this.#channel.ref();
    }
  }

  unrefCounted() {
    if (--this.#refs === 0 && !this.#refExplicitlySet) {
      this.#channel.unref();
      this.emit("unref");
    }
  }

  ref() {
    this.#refExplicitlySet = true;
    this.#channel.ref();
  }

  unref() {
    this.#refExplicitlySet = true;
    this.#channel.unref();
  }

  get fd() {
    return this.#channel ? this.#channel.fd : undefined;
  }
}

export default {
  setupChannel,
};