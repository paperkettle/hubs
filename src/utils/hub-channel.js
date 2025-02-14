import jwtDecode from "jwt-decode";
import { EventTarget } from "event-target-shim";
import { Presence } from "phoenix";
import { migrateChannelToSocket } from "./phoenix-utils";

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30;

function isSameMonth(da, db) {
  return da.getFullYear() == db.getFullYear() && da.getMonth() == db.getMonth();
}

function isSameDay(da, db) {
  return isSameMonth(da, db) && da.getDate() == db.getDate();
}

// Permissions that will be assumed if the user becomes the creator.
const HUB_CREATOR_PERMISSIONS = ["update_hub", "close_hub", "mute_users", "kick_users"];

export default class HubChannel extends EventTarget {
  constructor(store, hubId) {
    super();
    this.store = store;
    this.hubId = hubId;
    this._signedIn = !!this.store.state.credentials.token;
    this._permissions = {};
    this._blockedSessionIds = new Set();
  }

  get signedIn() {
    return this._signedIn;
  }

  // Returns true if this current session has the given permission.
  can(permission) {
    return this._permissions && this._permissions[permission];
  }

  // Returns true if the current session has the given permission, *or* will get the permission
  // if they sign in and become the creator.
  canOrWillIfCreator(permission) {
    if (this._getCreatorAssignmentToken() && HUB_CREATOR_PERMISSIONS.includes(permission)) return true;
    return this.can(permission);
  }

  // Migrates this hub channel to a new phoenix channel and presence
  async migrateToSocket(socket, params) {
    let presenceBindings;

    // Unbind presence, and then set up bindings after reconnect
    if (this.presence) {
      presenceBindings = {
        onJoin: this.presence.caller.onJoin,
        onLeave: this.presence.caller.onLeave,
        onSync: this.presence.caller.onSync
      };

      this.presence.onJoin(function() {});
      this.presence.onLeave(function() {});
      this.presence.onSync(function() {});
    }

    this.channel = await migrateChannelToSocket(this.channel, socket, params);
    this.presence = new Presence(this.channel);

    if (presenceBindings) {
      this.presence.onJoin(presenceBindings.onJoin);
      this.presence.onLeave(presenceBindings.onLeave);
      this.presence.onSync(presenceBindings.onSync);
    }
  }

  setPhoenixChannel = channel => {
    this.channel = channel;
    this.presence = new Presence(channel);
  };

  setPermissionsFromToken = token => {
    // Note: token is not verified.
    this._permissions = jwtDecode(token);
    this.dispatchEvent(new CustomEvent("permissions_updated"));

    // Refresh the token 1 minute before it expires.
    const nextRefresh = new Date(this._permissions.exp * 1000 - 60 * 1000) - new Date();
    setTimeout(async () => {
      const result = await this.fetchPermissions();
      this.dispatchEvent(new CustomEvent("permissions-refreshed", { detail: result }));
    }, nextRefresh);
  };

  sendEntryEvent = async () => {
    if (!this.channel) {
      console.warn("No phoenix channel initialized before room entry.");
      return;
    }

    let entryDisplayType = "Screen";

    if (navigator.getVRDisplays) {
      const vrDisplay = (await navigator.getVRDisplays()).find(d => d.isPresenting);

      if (vrDisplay) {
        entryDisplayType = vrDisplay.displayName;
      }
    }

    // This is fairly hacky, but gets the # of initial occupants
    let initialOccupantCount = 0;

    if (NAF.connection.adapter && NAF.connection.adapter.publisher) {
      initialOccupantCount = NAF.connection.adapter.publisher.initialOccupants.length;
    }

    const entryTimingFlags = this.getEntryTimingFlags();

    const entryEvent = {
      ...entryTimingFlags,
      initialOccupantCount,
      entryDisplayType,
      userAgent: navigator.userAgent
    };

    this.channel.push("events:entered", entryEvent);
  };

  getEntryTimingFlags = () => {
    const entryTimingFlags = { isNewDaily: true, isNewMonthly: true, isNewDayWindow: true, isNewMonthWindow: true };
    const storedLastEnteredAt = this.store.state.activity.lastEnteredAt;

    if (!storedLastEnteredAt) {
      return entryTimingFlags;
    }

    const now = new Date();
    const lastEntered = new Date(storedLastEnteredAt);
    const msSinceLastEntered = now - lastEntered;

    // note that new daily and new monthly is based on client local time
    entryTimingFlags.isNewDaily = !isSameDay(now, lastEntered);
    entryTimingFlags.isNewMonthly = !isSameMonth(now, lastEntered);
    entryTimingFlags.isNewDayWindow = msSinceLastEntered > MS_PER_DAY;
    entryTimingFlags.isNewMonthWindow = msSinceLastEntered > MS_PER_MONTH;

    return entryTimingFlags;
  };

  sendObjectSpawnedEvent = objectType => {
    if (!this.channel) {
      console.warn("No phoenix channel initialized before object spawn.");
      return;
    }

    const spawnEvent = {
      object_type: objectType
    };

    this.channel.push("events:object_spawned", spawnEvent);
  };

  sendProfileUpdate = () => {
    this.channel.push("events:profile_updated", { profile: this.store.state.profile });
  };

  updateScene = url => {
    if (!this._permissions.update_hub) return "unauthorized";
    this.channel.push("update_scene", { url });
  };

  rename = name => {
    if (!this._permissions.update_hub) return "unauthorized";
    this.channel.push("update_hub", { name });
  };

  closeHub = () => {
    if (!this._permissions.close_hub) return "unauthorized";
    this.channel.push("close_hub", {});
  };

  subscribe = subscription => {
    this.channel.push("subscribe", { subscription });
  };

  // If true, will tell the server to not send us any NAF traffic
  allowNAFTraffic = allow => {
    this.channel.push(allow ? "unblock_naf" : "block_naf", {});
  };

  unsubscribe = subscription => {
    return new Promise(resolve => this.channel.push("unsubscribe", { subscription }).receive("ok", resolve));
  };

  sendMessage = (body, type = "chat") => {
    if (!body) return;
    this.channel.push("message", { body, type });
  };

  _getCreatorAssignmentToken = () => {
    const creatorAssignmentTokenEntry =
      this.store.state.creatorAssignmentTokens &&
      this.store.state.creatorAssignmentTokens.find(t => t.hubId === this.hubId);

    return creatorAssignmentTokenEntry && creatorAssignmentTokenEntry.creatorAssignmentToken;
  };

  signIn = token => {
    return new Promise((resolve, reject) => {
      const creator_assignment_token = this._getCreatorAssignmentToken();

      this.channel
        .push("sign_in", { token, creator_assignment_token })
        .receive("ok", ({ perms_token }) => {
          this.setPermissionsFromToken(perms_token);
          this._signedIn = true;
          resolve();
        })
        .receive("error", err => {
          if (err.reason === "invalid_token") {
            console.warn("sign in failed", err);
            // Token expired or invalid TODO purge from storage if possible
            resolve();
          } else {
            console.error("sign in failed", err);
            reject();
          }
        });
    });
  };

  signOut = () => {
    return new Promise((resolve, reject) => {
      this.channel
        .push("sign_out")
        .receive("ok", () => {
          this._permissions = {};
          this._signedIn = false;
          this.dispatchEvent(new CustomEvent("permissions_updated"));
          resolve();
        })
        .receive("error", reject);
    });
  };

  getHost = () => {
    return new Promise((resolve, reject) => {
      this.channel
        .push("get_host")
        .receive("ok", res => {
          resolve(res.host);
        })
        .receive("error", reject);
    });
  };

  pin = (id, gltfNode, fileId, fileAccessToken, promotionToken) => {
    const payload = { id, gltf_node: gltfNode };
    if (fileId && promotionToken) {
      payload.file_id = fileId;
      payload.file_access_token = fileAccessToken;
      payload.promotion_token = promotionToken;
    }
    return new Promise((resolve, reject) => {
      this.channel
        .push("pin", payload)
        .receive("ok", resolve)
        .receive("error", reject);
    });
  };

  unpin = (id, fileId) => {
    const payload = { id };
    if (fileId) {
      payload.file_id = fileId;
    }
    this.channel.push("unpin", payload);
  };

  fetchPermissions = () => {
    return new Promise((resolve, reject) => {
      this.channel
        .push("refresh_perms_token")
        .receive("ok", res => {
          this.setPermissionsFromToken(res.perms_token);
          resolve({ permsToken: res.perms_token, permissions: this._permissions });
        })
        .receive("error", reject);
    });
  };

  mute = sessionId => {
    this.channel.push("mute", { session_id: sessionId });
  };

  hide = sessionId => {
    NAF.connection.adapter.block(sessionId);
    this._blockedSessionIds.add(sessionId);
  };

  unhide = sessionId => {
    if (!this._blockedSessionIds.has(sessionId)) return;
    NAF.connection.adapter.unblock(sessionId);
    NAF.connection.entities.completeSync(sessionId);
    this._blockedSessionIds.delete(sessionId);
  };

  isHidden = sessionId => this._blockedSessionIds.has(sessionId);

  kick = async sessionId => {
    const permsToken = await this.fetchPermissions();
    NAF.connection.adapter.kick(sessionId, permsToken);
    this.channel.push("kick", { session_id: sessionId });
  };

  requestSupport = () => this.channel.push("events:request_support", {});
  favorite = () => this.channel.push("favorite", {});
  unfavorite = () => this.channel.push("unfavorite", {});

  disconnect = () => {
    if (this.channel) {
      this.channel.socket.disconnect();
    }
  };
}
