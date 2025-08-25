// locker.js
'use strict';

const fs = require('fs');
const path = require('path');
const login = require('facebook-chat-api');

// ---------- FILE PATHS ----------
const LOCK_FILE = path.join(__dirname, 'lockdata.json');
const MSG_FILE = path.join(__dirname, 'messages.txt');

// ---------- UTIL: load/save lockdata ----------
function loadLockData(){
  try {
    if(fs.existsSync(LOCK_FILE)){
      return JSON.parse(fs.readFileSync(LOCK_FILE,'utf8'));
    }
  } catch(e){ console.error('Error loading lockdata:', e); }
  // default structure
  return {
    lockedNames: {},      // { threadID: "Group Name" }
    lockedNicks: {},      // { threadID: { userID: "Nickname" } }
    settings: {
      admin: process.env.ADMIN_UID || '',   // initial admin UID
      prefix: process.env.PREFIX || '!'     // initial prefix
    }
  };
}
function saveLockData(data){
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2));
  } catch(e){ console.error('Error saving lockdata:', e); }
}

// ---------- UTIL: messages ----------
function loadMessages(){
  try {
    if(fs.existsSync(MSG_FILE)){
      return fs.readFileSync(MSG_FILE,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    }
  } catch(e){ console.error('Error loading messages:', e); }
  return ["⚠️ No messages found. Edit messages.txt or use addmsg command."];
}
function saveMessages(arr){
  try {
    fs.writeFileSync(MSG_FILE, arr.join('\n'));
  } catch(e){ console.error('Error saving messages:', e); }
}

// ---------- UTIL: appState loader ----------
function loadAppState(){
  // Preference: appstate.json file in repo (not recommended for public repos)
  const filePath = path.join(__dirname, 'appstate.json');
  if(fs.existsSync(filePath)){
    return JSON.parse(fs.readFileSync(filePath,'utf8'));
  }
  // Or read from APPSTATE_BASE64 env var (recommended)
  if(process.env.APPSTATE_BASE64){
    try {
      const raw = Buffer.from(process.env.APPSTATE_BASE64, 'base64').toString('utf8');
      return JSON.parse(raw);
    } catch(e){
      console.error('Invalid APPSTATE_BASE64:', e);
    }
  }
  throw new Error('No appstate found — provide appstate.json or set APPSTATE_BASE64 env var.');
}

// ---------- START ----------
const lockdata = loadLockData();
let messages = loadMessages();

let ADMIN_UID = String(lockdata.settings.admin || process.env.ADMIN_UID || '');
let PREFIX = String(lockdata.settings.prefix || process.env.PREFIX || '!');

console.log('Starting FB Locker Bot');
console.log('Admin UID:', ADMIN_UID || '(not set)');
console.log('Command prefix:', PREFIX);

let appState;
try {
  appState = loadAppState();
} catch(err) {
  console.error('AppState load error:', err.message);
  process.exit(1);
}

login({ appState }, (err, api) => {
  if (err) {
    console.error('Login error:', err);
    return;
  }

  console.log('✅ Logged in via appState.');

  // Helper: save changes
  function persistSettings(){
    lockdata.settings.admin = ADMIN_UID;
    lockdata.settings.prefix = PREFIX;
    saveLockData(lockdata);
  }

  // Helper: send system message to thread
  function sysMsg(threadID, text){
    api.sendMessage(text, threadID);
  }

  // Listen
  api.listenMqtt((err, event) => {
    if (err) {
      console.error('Listen error:', err);
      return;
    }

    // ---------- COMMAND HANDLER (only from admin) ----------
    if (event.type === 'message' && event.body && String(event.senderID) === String(ADMIN_UID)) {
      const body = event.body.trim();
      if (!body.startsWith(PREFIX)) return; // not a command

      const raw = body.slice(PREFIX.length).trim();
      if (!raw) return;
      const parts = raw.split(' ');
      const cmd = parts.shift().toLowerCase();

      const threadID = event.threadID;

      // ---------- Commands ----------
      if (cmd === 'help') {
        const helpText = [
          `📘 Commands (prefix = ${PREFIX})`,
          `${PREFIX}lockname <Group Name> — lock group title`,
          `${PREFIX}unlockname — remove group-name lock`,
          `${PREFIX}locknick <UID> <Nickname> — lock nickname for UID`,
          `${PREFIX}unlocknick <UID> — unlock nickname for UID`,
          `${PREFIX}msg <UID> — send a random message (mentions target)`,
          `${PREFIX}addmsg <text> — add message to messages.txt`,
          `${PREFIX}delmsg <index> — delete message index (use listmsgs to see indices)`,
          `${PREFIX}listmsgs — list messages`,
          `${PREFIX}reloadmsgs — reload messages.txt from disk`,
          `${PREFIX}setprefix <new> — change command prefix`,
          `${PREFIX}setadmin <UID> — change admin UID to UID (transfer admin)`,
          `${PREFIX}listlocks — show current locks`,
          `${PREFIX}unlockall — remove all locks in this thread`,
          `${PREFIX}help`
        ].join('\n');
        sysMsg(threadID, helpText);
      }

      // lockname
      else if (cmd === 'lockname') {
        const name = parts.join(' ').trim();
        if (!name) return sysMsg(threadID, 'Usage: ' + PREFIX + 'lockname <Group Name>');
        lockdata.lockedNames[threadID] = name;
        saveLockData(lockdata);
        api.setTitle(name, threadID, (e)=> {
          if(e) sysMsg(threadID, 'Error setting title: ' + e);
          else sysMsg(threadID, '🔒 Group name locked to: ' + name);
        });
      }

      // unlockname
      else if (cmd === 'unlockname') {
        if (lockdata.lockedNames[threadID]) {
          delete lockdata.lockedNames[threadID];
          saveLockData(lockdata);
          sysMsg(threadID, '🔓 Group name lock removed for this thread.');
        } else sysMsg(threadID, 'No group-name lock set for this thread.');
      }

      // locknick UID Nick
      else if (cmd === 'locknick') {
        if (parts.length < 2) return sysMsg(threadID, 'Usage: ' + PREFIX + 'locknick <UID> <Nickname>');
        const uid = parts.shift();
        const nick = parts.join(' ').trim();
        if (!nick) return sysMsg(threadID, 'Provide a nickname.');
        if (!lockdata.lockedNicks[threadID]) lockdata.lockedNicks[threadID] = {};
        lockdata.lockedNicks[threadID][uid] = nick;
        saveLockData(lockdata);
        api.changeNickname(nick, threadID, uid, (e)=> {
          if(e) sysMsg(threadID, 'Error set nick: ' + e);
          else sysMsg(threadID, `🔒 Nick locked for ${uid}: ${nick}`);
        });
      }

      // unlocknick UID
      else if (cmd === 'unlocknick') {
        if (parts.length !== 1) return sysMsg(threadID, 'Usage: ' + PREFIX + 'unlocknick <UID>');
        const uid = parts[0];
        if (lockdata.lockedNicks[threadID] && lockdata.lockedNicks[threadID][uid]) {
          delete lockdata.lockedNicks[threadID][uid];
          // cleanup empty container
          if (Object.keys(lockdata.lockedNicks[threadID]).length === 0) delete lockdata.lockedNicks[threadID];
          saveLockData(lockdata);
          sysMsg(threadID, `🔓 Nick lock removed for ${uid}`);
        } else sysMsg(threadID, 'No nick lock for that UID in this thread.');
      }

      // msg UID (mention)
      else if (cmd === 'msg') {
        if (parts.length !== 1) return sysMsg(threadID, 'Usage: ' + PREFIX + 'msg <UID>');
        const tid = parts[0];
        messages = loadMessages(); // ensure newest
        const chosen = messages[Math.floor(Math.random() * messages.length)];
        const sendObj = {
          body: chosen,
          mentions: [{ id: tid, tag: '@target' }]
        };
        api.sendMessage(sendObj, threadID, (e)=> {
          if(e) sysMsg(threadID, 'Error sending message: ' + e);
        });
      }

      // addmsg <text>
      else if (cmd === 'addmsg') {
        const text = parts.join(' ').trim();
        if (!text) return sysMsg(threadID, 'Usage: ' + PREFIX + 'addmsg <text>');
        messages.push(text);
        saveMessages(messages);
        sysMsg(threadID, '✅ Message added. Use listmsgs to view.');
      }

      // delmsg <index>
      else if (cmd === 'delmsg') {
        if (parts.length !== 1) return sysMsg(threadID, 'Usage: ' + PREFIX + 'delmsg <index>');
        const idx = parseInt(parts[0],10);
        if (isNaN(idx) || idx < 1 || idx > messages.length) return sysMsg(threadID, 'Invalid index.');
        const removed = messages.splice(idx-1,1);
        saveMessages(messages);
        sysMsg(threadID, `Deleted message #${idx}: ${removed}`);
      }

      // listmsgs
      else if (cmd === 'listmsgs') {
        messages = loadMessages();
        if(messages.length === 0) return sysMsg(threadID, 'No messages.');
        const out = messages.map((m,i)=> `${i+1}. ${m}`).join('\n');
        // If too long, send partial
        sysMsg(threadID, '📋 Messages:\n' + out);
      }

      // reloadmsgs
      else if (cmd === 'reloadmsgs') {
        messages = loadMessages();
        sysMsg(threadID, '🔄 messages.txt reloaded. Total: ' + messages.length);
      }

      // setprefix <new>
      else if (cmd === 'setprefix') {
        if (parts.length !== 1) return sysMsg(threadID, 'Usage: ' + PREFIX + 'setprefix <newPrefix>');
        PREFIX = parts[0];
        persistSettings();
        sysMsg(threadID, `✅ Prefix changed to: ${PREFIX}`);
      }

      // setadmin <UID>
      else if (cmd === 'setadmin') {
        if (parts.length !== 1) return sysMsg(threadID, 'Usage: ' + PREFIX + 'setadmin <UID>');
        const newAdmin = parts[0];
        ADMIN_UID = String(newAdmin);
        persistSettings();
        sysMsg(threadID, `✅ Admin changed to UID: ${ADMIN_UID}`);
      }

      // listlocks
      else if (cmd === 'listlocks') {
        const ln = lockdata.lockedNames[threadID] ? `Group: ${lockdata.lockedNames[threadID]}` : 'Group: (none)';
        const lns = lockdata.lockedNicks[threadID] ? Object.entries(lockdata.lockedNicks[threadID]).map(([u,n]) => `${u} -> ${n}`).join('\n') : '(no nick locks)';
        sysMsg(threadID, `🔐 Locks for this thread:\n${ln}\nNick locks:\n${lns}`);
      }

      // unlockall
      else if (cmd === 'unlockall') {
        if (lockdata.lockedNames[threadID]) delete lockdata.lockedNames[threadID];
        if (lockdata.lockedNicks[threadID]) delete lockdata.lockedNicks[threadID];
        saveLockData(lockdata);
        sysMsg(threadID, '🔓 All locks removed for this thread.');
      }

      else {
        sysMsg(threadID, 'Unknown command. Use ' + PREFIX + 'help');
      }
    } // end admin-command block

    // ---------- AUTO-RESET EVENTS ----------
    if (event.type === 'event') {
      // thread name change
      if (event.logMessageType === 'log:thread-name') {
        const tid = event.threadID;
        if (lockdata.lockedNames && lockdata.lockedNames[tid]) {
          const name = lockdata.lockedNames[tid];
          setTimeout(()=> {
            api.setTitle(name, tid, (e)=> {
              if(e) console.error('Failed resetting title:', e);
              else console.log(`Reset group title to "${name}" for thread ${tid}`);
            });
          }, 1000);
        }
      }

      // user nickname changed
      if (event.logMessageType === 'log:user-nickname') {
        try {
          const tid = event.threadID;
          const uid = event.logMessageData && (event.logMessageData.participant_id || event.logMessageData.user_id);
          if (uid && lockdata.lockedNicks && lockdata.lockedNicks[tid] && lockdata.lockedNicks[tid][uid]) {
            const nick = lockdata.lockedNicks[tid][uid];
            setTimeout(()=> {
              api.changeNickname(nick, tid, uid, (e)=> {
                if(e) console.error('Failed resetting nick:', e);
                else console.log(`Reset nick ${uid} -> ${nick} in thread ${tid}`);
              });
            }, 1000);
          }
        } catch(e){ console.error('Error processing nickname event:', e); }
      }
    } // end event type handler
  }); // end listen
}); // end login
