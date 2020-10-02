const
  request = require('request'),
  SteamTotp = require('steam-totp'),
  SteamCommunity = require('steamcommunity'),
  steam = new SteamCommunity(),
  fs = require('fs'),
  WebSocket = require('ws'),
  dateFormat = require('dateformat'),
  util = require('util'),
  TradeOfferManager = require('steam-tradeoffer-manager'),
  config = require('./config.json'),
  Push = require('pushover-notifications');

let userInventory = [];
let pushoverClient = undefined;
let manager = undefined;
let ts = 0;

if (config.pushover) {
  pushoverClient = new Push({
    user: config.pushoverUser,
    token: config.pushoverToken,
  });
}
const log = console.log;
console.log = function (d, dc = false, color = '\x1b[0m') {
  log(color + "[" + dateFormat(new Date(), "yyyy-mm-dd H:MM:ss") + "] " + util.format(d));
};


if (config.steam) {
  manager = new TradeOfferManager({
    "domain": config.domain,
    "language": "en",
    "pollInterval": 30000,
    "cancelTime": 9 * 60 * 1000, // cancel outgoing offers after 9mins
  });
  steamLogin().then(() => {
    console.log('Logged in to steam.');
  }).catch(e => {
    console.log('Failed to login to steam.');
  });
}

init();

const mainHeaders = {
  'User-Agent': config.useragent,
  'Origin': 'https://www.rollbit.com',
  'Accept': 'application/json, text/*',
  'Connection': 'keep-alive',
};

const offerSentFor = [];

// dodge the first few trade_status event to prevent the double item send if the offer is already at 'Sending' state
let dodge = false;

let balance = -1;
function init() {
  delete this.connection;
  this.connection = new WebSocket('wss://ws.rollbit.com/', {
    headers: {
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache',
      'User-Agent': config.useragent,
      'Upgrade': 'websocket',
      'Cookie': config.mainCookie,
      'Origin': 'https://www.rollbit.com',
      'Sec-WebSocket-Version': 13,
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'de-DE,hu;q=0.9,en-US;q=0.8,en;q=0.7,de;q=0.6,fr;q=0.5,sk;q=0.4,it;q=0.3,el;q=0.2,und;q=0.1',
    },
  });

  if (this.connection !== null) {
    this.connection.onmessage = async (e) => {
      const data = JSON.parse(e.data);
      if (data[0] === 'balance') {
        if (balance !== data[1].balance) {
          console.log('Logged in to rollbit.com');
          balance = data[1].balance;
          sendMessage(`Balance: ${data[1].balance}`, true);
        }
      }
      if (data[0] === 'steam/deposit') {
        switch (data[1].state) {
          case 'listed':
            break;
          case 'withdrawn':
            try {
              await confirmTrade(data[1].ref);
              if (offerSentFor.indexOf(data[1].ref) === -1) {
                offerSentFor.push(data[1].ref);
                const details = await getDetails(data[1].ref);
                if (config.steam) {
                  sendSteamOffer(details.trade.items[0], details.trade.tradeUrl);
                }
                sendMessage(`<@${config.discordUserId}> Deposit offer for ${details.trade.items[0].name} accepted`, config.discord, config.pushover);
                console.log(`Deposit offer for ${details.trade.items[0].name} accepted`);
              }
            } catch (e) {
              console.log(e);
            }
            break;
        }
      }
      // console.log(e);
    }
  }
}

function getDetails(depositId) {
  return new Promise((resolve, reject) => {
    const options = {
      url: 'https://api.rollbit.com/steam/deposit/trade-details',
      method: 'POST',
      json: {
        "ref": depositId
      },
      headers: {
        Cookie: config.mainCookie,
        ...mainHeaders,
      },
    };

    request(options, (error, response, body) => {
      if (!error && response.statusCode === 200) {
        resolve(body);
      } else {
        reject(response);
      }
    });
  });
}

// becarefull with this shit, and set properly! because rollbit doesnt give assetid's.
// so if you have a good float FT fire serpent, the script can send that instead of shit float if you didnt put the assetid to the list.
const exceptAssetIds = [
  '18916427900'
];

function sendSteamOffer(sendItem, tradeUrl) {
  steamLogin().then(() => {
    const items = [];
    userInventory.forEach(item => {
      if (
        item.market_hash_name == sendItem.name &&
        item.instanceid == sendItem.instanceid &&
        item.classid == sendItem.classid &&
        exceptAssetIds.indexOf(item.assetid) == -1 &&
        !items.length
      ) {
        items.push({
          assetid: item.assetid,
          appid: 730,
          contextid: 2,
        });
      }
    });
    var offer = manager.createOffer(tradeUrl);
    offer.addMyItems(items);
    offer.send(function (err, status) {
      if (offer.id !== null) {
        setTimeout(() => {
          steam.acceptConfirmationForObject(config.identitySecret, offer.id, status => {
            console.log('Deposit item sent & confirmed');
          });
        }, 3000);
      }
    });
  }).catch(e => {
    console.log(e);
  });
}
function confirmTrade(depositId) {
  return new Promise((resolve, reject) => {
    const options = {
      url: 'https://api.rollbit.com/steam/deposit/accept',
      method: 'POST',
      json: {
        "ref": depositId
      },
      headers: {
        Cookie: config.mainCookie,
        ...mainHeaders,
      },
    };

    request(options, (error, response, body) => {
      if (!error && response.statusCode === 200) {
        resolve(body);
      } else {
        reject(response);
      }
    });
  });
}
function sendMessage(msg, discord = false, pushover = false) {
  if (discord) {
    request({
      url: config.discordHook,
      method: 'POST',
      json: true,
      body: {
        content: msg,
      },
    }, (error, response, b) => {
      //
    });
  }
  if (pushover) {
    pushoverClient.send({
      message: msg,
      title: '[ROLLBIT] Deposit',
      priority: 1,
    }, (err, result) => {
      if (err) {
        throw err;
      }
    });
  }
}
// function getInventory(steamId) {
//   return new Promise((resolve, reject) => {
//     manager.getUserInventoryContents(steamId, 730, 2, true, function (err, inventory, currency) {
//       if (inventory) {
//         resolve(inventory);
//       } else {
//         resolve([]);
//       }
//     });
//   });
// }
function loadInventory(steamId) {
  return new Promise(async (resolve, reject) => {
    const options = {
      url: `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=1000`,
      method: 'GET',
      gzip: true,
      json: true,
    };
    request(options, async (error, response, body) => {
      if (!error) {
        const items = [];
        body.assets.forEach( asset => {
          const item = body.descriptions.find(desc => desc.instanceid === asset.instanceid && desc.classid === asset.classid);
          items.push({
            ...item,
            assetid: asset.assetid            
          });
        });
        resolve(items);
      } else {
        resolve(null);
      }
    });
  });
}

function steamLogin() {
  return new Promise(async (resolve, reject) => {

    if ((new Date() - ts) < 30 * 60 * 1000) {
      return resolve();
    }

    ts = new Date();

    userInventory = await loadInventory(config.steam64Id);

    const logOnOptions = {
      "accountName": config.accountName,
      "password": config.password,
      "twoFactorCode": SteamTotp.getAuthCode(config.sharedSecret)
    };

    if (fs.existsSync('steamguard.txt')) {
      logOnOptions.steamguard = fs.readFileSync('steamguard.txt').toString('utf8');
    }

    if (fs.existsSync('polldata.json')) {
      manager.pollData = JSON.parse(fs.readFileSync('polldata.json'));
    }
    steam.login(logOnOptions, function (err, sessionID, cookies, steamguard) {
      if (err) {
        console.log("Steam login fail: " + err.message);
      }
      fs.writeFile('steamguard.txt', steamguard, (err) => {
        if (err) throw err;
      });
      manager.setCookies(cookies, function (err) {
        if (err) {
          console.log(err);
          return;
        }
        resolve(true);
      });
    });
  });
}