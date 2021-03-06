/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource:///modules/imServices.jsm");
Cu.import("resource:///modules/imStatusUtils.jsm");
Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("resource:///modules/jsProtoHelper.jsm");

var gLastUIConvId = 0;
var gLastPrplConvId = 0;

XPCOMUtils.defineLazyGetter(this, "bundle", function()
  Services.strings.createBundle("chrome://chat/locale/conversations.properties")
);

function UIConversation(aPrplConversation)
{
  this._prplConv = {};
  this.id = ++gLastUIConvId;
  this._observers = [];
  this._messages = [];
  this.changeTargetTo(aPrplConversation);
  let iface = Ci["prplIConv" + (aPrplConversation.isChat ? "Chat" : "IM")];
  this._interfaces = this._interfaces.concat(iface);
  let contact = this.contact;
  if (contact) {
    // XPConnect will create a wrapper around 'this' here,
    // so the list of exposed interfaces shouldn't change anymore.
    contact.addObserver(this);
    this._observedContact = contact;
  }
  Services.obs.notifyObservers(this, "new-ui-conversation", null);
}

UIConversation.prototype = {
  __proto__: ClassInfo(["imIConversation", "prplIConversation", "nsIObserver"],
                       "UI conversation"),
  _observedContact: null,
  get contact() {
    let target = this.target;
    if (!target.isChat && target.buddy)
      return target.buddy.buddy.contact;
    return null;
  },
  get target() this._prplConv[this._currentTargetId],
  set target(aPrplConversation) {
    this.changeTargetTo(aPrplConversation);
  },
  _currentTargetId: 0,
  changeTargetTo: function(aPrplConversation) {
    let id = aPrplConversation.id;
    if (this._currentTargetId == id)
      return;

    if (!(id in this._prplConv)) {
      this._prplConv[id] = aPrplConversation;
      aPrplConversation.addObserver(this.observeConv.bind(this, id));
    }

    let shouldNotify = this._currentTargetId;
    this._currentTargetId = id;
    if (!this.isChat) {
      let buddy = this.buddy;
      if (buddy)
        ({statusType: this.statusType, statusText: this.statusText}) = buddy;
    }
    if (shouldNotify) {
      this.notifyObservers(this, "target-prpl-conversation-changed");
      let target = this.target;
      let params = [target.title, target.account.protocol.name];
      this.systemMessage(bundle.formatStringFromName("targetChanged",
                                                     params, params.length));
    }
  },
  // Returns a boolean indicating if the ui-conversation was closed.
  // If the conversation was closed, aContactId.value is set to the contact id
  // or 0 if no contact was associated with the conversation.
  removeTarget: function(aPrplConversation, aContactId) {
    let id = aPrplConversation.id;
    if (!(id in this._prplConv))
      throw "unknown prpl conversation";

    delete this._prplConv[id];
    if (this._currentTargetId != id)
      return false;

    for (let newId in this._prplConv) {
      this.changeTargetTo(this._prplConv[newId]);
      return false;
    }

    if (this._observedContact) {
      this._observedContact.removeObserver(this);
      aContactId.value = this._observedContact.id;
      delete this._observedContact;
    }
    else
      aContactId.value = 0;

    delete this._currentTargetId;
    this.notifyObservers(this, "ui-conversation-closed");
    return true;
  },

  _unreadMessageCount: 0,
  get unreadMessageCount() this._unreadMessageCount,
  _unreadTargetedMessageCount: 0,
  get unreadTargetedMessageCount() this._unreadTargetedMessageCount,
  _unreadIncomingMessageCount: 0,
  get unreadIncomingMessageCount() this._unreadIncomingMessageCount,
  markAsRead: function() {
    delete this._unreadMessageCount;
    delete this._unreadTargetedMessageCount;
    delete this._unreadIncomingMessageCount;
    this._notifyUnreadCountChanged();
  },
  _lastNotifiedUnreadCount: 0,
  _notifyUnreadCountChanged: function() {
    if (this._unreadIncomingMessageCount == this._lastNotifiedUnreadCount)
      return;

    this._lastNotifiedUnreadCount = this._unreadIncomingMessageCount;
    for each (let observer in this._observers)
      observer.observe(this, "unread-message-count-changed",
                       this._unreadIncomingMessageCount.toString());
  },
  getMessages: function(aMessageCount) {
    if (aMessageCount)
      aMessageCount.value = this._messages.length;
    return this._messages;
  },
  checkClose: function() {
    if (!this._currentTargetId)
      return true; // already closed.

    if (!Services.prefs.getBoolPref("messenger.conversations.alwaysClose") &&
        (this.isChat && !this.left ||
         !this.isChat && this.unreadIncomingMessageCount != 0))
      return false;

    this.close();
    return true;
  },

  observe: function(aSubject, aTopic, aData) {
    if (aTopic == "contact-no-longer-dummy") {
      let oldId = parseInt(aData);
      // gConversationsService is ugly... :(
      delete gConversationsService._uiConvByContactId[oldId];
      gConversationsService._uiConvByContactId[aSubject.id] = this;
    }
    else if (aTopic == "account-buddy-status-changed") {
      if (!this._statusUpdatePending &&
          aSubject.account.id == this.account.id &&
          aSubject.buddy.id == this.buddy.buddy.id) {
        this._statusUpdatePending = true;
        Services.tm.mainThread.dispatch(this.updateBuddyStatus.bind(this),
                                        Ci.nsIEventTarget.DISPATCH_NORMAL);
      }
    }
    else if (aTopic == "account-buddy-icon-changed") {
      if (!this._statusUpdatePending &&
          aSubject.account.id == this.account.id &&
          aSubject.buddy.id == this.buddy.buddy.id) {
        this._iconUpdatePending = true;
        Services.tm.mainThread.dispatch(this.updateIcon.bind(this),
                                        Ci.nsIEventTarget.DISPATCH_NORMAL);
      }
    }
  },

  _iconUpdatePending: false,
  updateIcon: function() {
    delete this._iconUpdatePending;
    this.notifyObservers(this, "update-buddy-icon");
  },

  _statusUpdatePending: false,
  updateBuddyStatus: function() {
    delete this._statusUpdatePending;
    let {statusType: statusType, statusText: statusText} = this.buddy;

    if (("statusType" in this) && this.statusType == statusType &&
        this.statusText == statusText)
      return;

    let wasUnknown = this.statusType == Ci.imIStatusInfo.STATUS_UNKNOWN;
    this.statusType = statusType;
    this.statusText = statusText;

    this.notifyObservers(this, "update-buddy-status");

    let msg;
    if (statusType == Ci.imIStatusInfo.STATUS_UNKNOWN)
      msg = bundle.formatStringFromName("statusUnknown", [this.title], 1);
    else {
      let status = Status.toLabel(statusType);
      let stringId = wasUnknown ? "statusChangedFromUnknown" : "statusChanged";
      if (this._justReconnected) {
        stringId = "statusKnown";
        delete this._justReconnected;
      }
      if (statusText) {
        msg = bundle.formatStringFromName(stringId + "WithStatusText",
                                          [this.title, status, statusText],
                                          3);
      }
      else
        msg = bundle.formatStringFromName(stringId, [this.title, status], 2);
    }
    this.systemMessage(msg);
  },

  _disconnected: false,
  disconnecting: function() {
    if (this._disconnected)
      return;

    this._disconnected = true;
    if (this.contact)
      return; // handled by the contact observer.

    if (this.isChat && this.left)
      this._wasLeft = true;
    else
      this.systemMessage(bundle.GetStringFromName("accountDisconnected"));
    this.notifyObservers(this, "update-buddy-status");
  },
  connected: function() {
    if (this._disconnected) {
      delete this._disconnected;
      if (!this.isChat)
        this._justReconnected = true;
      else if (!this._wasLeft)
        this.systemMessage(bundle.GetStringFromName("accountReconnected"));
      else
        delete this._wasLeft;
    }
    this.notifyObservers(this, "update-buddy-status");
  },

  observeConv: function(aTargetId, aSubject, aTopic, aData) {
    if (aTargetId != this._currentTargetId &&
        (aTopic == "new-text" ||
         (aTopic == "update-typing" &&
          this._prplConv[aTargetId].typingState == Ci.prplIConvIM.TYPING)))
      this.target = this._prplConv[aTargetId];
    this.notifyObservers(aSubject, aTopic, aData);
    if (aTopic == "new-text") {
      Services.obs.notifyObservers(aSubject, aTopic, aData);
      if (aSubject.incoming && !aSubject.system &&
          (!this.isChat || aSubject.containsNick)) {
        this.notifyObservers(aSubject, "new-directed-incoming-message", aData);
        Services.obs.notifyObservers(aSubject, "new-directed-incoming-message", aData);
      }
    }
  },

  systemMessage: function(aText, aIsError) {
    let flags = {system: true, noLog: true, error: !!aIsError};
    (new Message("system", aText, flags)).conversation = this;
  },

  // prplIConversation
  get isChat() this.target.isChat,
  get account() this.target.account,
  get name() this.target.name,
  get normalizedName() this.target.normalizedName,
  get title() this.target.title,
  get startDate() this.target.startDate,
  sendMsg: function (aMsg) { this.target.sendMsg(aMsg); },
  unInit: function() {
    for each (let conv in this._prplConv)
      gConversationsService.forgetConversation(conv);
    if (this._observedContact) {
      this._observedContact.removeObserver(this);
      delete this._observedContact;
    }
    this._prplConv = {}; // Prevent .close from failing.
    delete this._currentTargetId;
    this.notifyObservers(this, "ui-conversation-destroyed");
  },
  close: function() {
    for each (let conv in this._prplConv)
      conv.close();
    if (!this.hasOwnProperty("_currentTargetId"))
      return;
    delete this._currentTargetId;
    this.notifyObservers(this, "ui-conversation-closed");
    Services.obs.notifyObservers(this, "ui-conversation-closed", null);
  },
  addObserver: function(aObserver) {
    if (this._observers.indexOf(aObserver) == -1)
      this._observers.push(aObserver);
  },
  removeObserver: function(aObserver) {
    this._observers = this._observers.filter(function(o) o !== aObserver);
  },
  notifyObservers: function(aSubject, aTopic, aData) {
    if (aTopic == "new-text") {
      this._messages.push(aSubject);
      ++this._unreadMessageCount;
      if (aSubject.incoming && !aSubject.system) {
        ++this._unreadIncomingMessageCount;
        if (!this.isChat || aSubject.containsNick)
          ++this._unreadTargetedMessageCount;
      }
    }
    for each (let observer in this._observers) {
      if (!observer.observe && this._observers.indexOf(observer) == -1)
        continue; // observer removed by a previous call to another observer.
      observer.observe(aSubject, aTopic, aData);
    }
    this._notifyUnreadCountChanged();
  },

  // prplIConvIM
  get buddy() this.target.buddy,
  get typingState() this.target.typingState,
  sendTyping: function(aString) this.target.sendTyping(aString),

  // Chat only
  getParticipants: function() this.target.getParticipants(),
  get topic() this.target.topic,
  set topic(aTopic) { this.target.topic = aTopic; },
  get topicSetter() this.target.topicSetter,
  get topicSettable() this.target.topicSettable,
  get nick() this.target.nick,
  get left() this.target.left
};

var gConversationsService;
function ConversationsService() { gConversationsService = this; }
ConversationsService.prototype = {
  get wrappedJSObject() this,

  initConversations: function() {
    this._uiConv = {};
    this._uiConvByContactId = {};
    this._prplConversations = [];
    Services.obs.addObserver(this, "account-disconnecting", false);
    Services.obs.addObserver(this, "account-connected", false);
  },

  unInitConversations: function() {
    let UIConvs = this.getUIConversations();
    for (let UIConv of UIConvs)
      UIConv.unInit();
    delete this._uiConv;
    delete this._uiConvByContactId;
    // This should already be empty, but just to be sure...
    for each (let prplConv in this._prplConversations)
      prplConv.unInit();
    delete this._prplConversations;
    Services.obs.removeObserver(this, "account-disconnecting");
    Services.obs.removeObserver(this, "account-connected");
  },

  observe: function(aSubject, aTopic, aData) {
    if (aTopic == "account-connected") {
      for each (let conv in this._uiConv) {
        if (conv.account.id == aSubject.id)
          conv.connected();
      }
    }
    else if (aTopic == "account-disconnecting") {
      for each (let conv in this._uiConv) {
        if (conv.account.id == aSubject.id)
          conv.disconnecting();
      }
    }
  },

  addConversation: function(aPrplConversation) {
    // Give an id to the new conversation.
    aPrplConversation.id = ++gLastPrplConvId;
    this._prplConversations.push(aPrplConversation);

    // Notify observers.
    Services.obs.notifyObservers(aPrplConversation, "new-conversation", null);

    // Update or create the corresponding UI conversation.
    let contactId;
    if (!aPrplConversation.isChat) {
      let accountBuddy = aPrplConversation.buddy;
      if (accountBuddy)
        contactId = accountBuddy.buddy.contact.id;
    }

    if (contactId) {
      if (contactId in this._uiConvByContactId) {
        let uiConv = this._uiConvByContactId[contactId];
        uiConv.target = aPrplConversation;
        this._uiConv[aPrplConversation.id] = uiConv;
        return;
      }
    }

    let newUIConv = new UIConversation(aPrplConversation);
    this._uiConv[aPrplConversation.id] = newUIConv;
    if (contactId)
      this._uiConvByContactId[contactId] = newUIConv;
  },
  removeConversation: function(aPrplConversation) {
    Services.obs.notifyObservers(aPrplConversation, "conversation-closed", null);

    let uiConv = this.getUIConversation(aPrplConversation);
    delete this._uiConv[aPrplConversation.id];
    let contactId = {};
    if (uiConv.removeTarget(aPrplConversation, contactId)) {
      if (contactId.value)
        delete this._uiConvByContactId[contactId.value];
      Services.obs.notifyObservers(uiConv, "ui-conversation-closed", null);
    }
    this.forgetConversation(aPrplConversation);
  },
  forgetConversation: function(aPrplConversation) {
    aPrplConversation.unInit();

    this._prplConversations =
      this._prplConversations.filter(function(c) c !== aPrplConversation);
  },

  getUIConversations: function(aConvCount) {
    let rv = [];
    if (this._uiConv) {
      for (let prplConvId in this._uiConv) {
        // Since an UIConversation may be linked to multiple prplConversations,
        // we must ensure we don't return the same UIConversation twice,
        // by checking the id matches that of the active prplConversation.
        let uiConv = this._uiConv[prplConvId];
        if (prplConvId == uiConv.target.id)
          rv.push(uiConv);
      }
    }
    if (aConvCount)
      aConvCount.value = rv.length;
    return rv;
  },
  getUIConversation: function(aPrplConversation) {
    let id = aPrplConversation.id;
    if (this._uiConv && id in this._uiConv)
      return this._uiConv[id];
    throw "Unknown conversation";
  },
  getUIConversationByContactId: function(aId)
    (aId in this._uiConvByContactId) ? this._uiConvByContactId[aId] : null,

  getConversations: function() new nsSimpleEnumerator(this._prplConversations),
  getConversationById: function(aId) {
    for each (let conv in this._prplConversations)
      if (conv.id == aId)
        return conv;
    return null;
  },
  getConversationByNameAndAccount: function(aName, aAccount, aIsChat) {
    for each (let conv in this._prplConversations)
      if (conv.name == aName && conv.account.numericId == aAccount.numericId &&
          conv.isChat == aIsChat)
        return conv;
    return null;
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.imIConversationsService]),
  classDescription: "Conversations",
  classID: Components.ID("{b2397cd5-c76d-4618-8410-f344c7c6443a}"),
  contractID: "@mozilla.org/chat/conversations-service;1"
};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([ConversationsService]);
