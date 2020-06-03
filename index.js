const io = require('socket.io-client'),
  request = require('request'),
  SteamTotp = require('steam-totp'),
  express = require('express'),
  SteamCommunity = require('steamcommunity'),
  steam = new SteamCommunity(),
  fs = require('fs'),
  WebSocket = require('ws'),
  dateFormat = require('dateformat'),
  util = require('util'),
  TradeOfferManager = require('steam-tradeoffer-manager'),
  config = require('./config.json'),
  app = express();

const colors = {
  FgBlack: "\x1b[30m",
  FgRed: "\x1b[31m",
  FgGreen: "\x1b[32m",
  FgYellow: "\x1b[33m",
  FgBlue: "\x1b[34m",
  FgMagenta: "\x1b[35m",
  FgCyan: "\x1b[36m",
  FgWhite: "\x1b[37m",
};
const log = console.log;

let userInventory = [];

console.log = function (d, dc = false, color = '\x1b[0m') {
  log(color, "[" + dateFormat(new Date(), "yyyy-mm-dd H:MM:ss") + "] " + util.format(d));
};


let manager = null;
// if steam deposit enabled
if (config.steam) {
  manager = new TradeOfferManager({
    "domain": config.domain,
    "language": "en",
    "pollInterval": 30000,
    "cancelTime": 9 * 60 * 1000, // cancel outgoing offers after 9mins
  });
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
    console.log("Logged into Steam");
    manager.setCookies(cookies, function (err) {
      if (err) {
        console.log(err);
        return;
      }
      getInventory(config.steam64Id, 730).then(inventory => {
        userInventory = inventory;
      });
    });
  });
}

// do not terminate the app
app.listen(config.port);

const mainHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.61 Safari/537.36',
  'Origin': 'https://www.rollbit.com',
  'Accept': 'application/json, text/*',
  'Connection': 'keep-alive',
};

const offerSentFor = [];

// dodge the first few trade_status event to prevent the double item send if the offer is already at 'Sending' state
let dodge = true;

function init() {
  this.connection = new WebSocket('wss://ws.rollbit.com/', {
    headers: {
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.61 Safari/537.36',
      'Upgrade': 'websocket',
      'Cookie': config.mainCookie,
      'Origin': 'https://www.rollbit.com',
      'Sec-WebSocket-Version': 13,
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'de-DE,hu;q=0.9,en-US;q=0.8,en;q=0.7,de;q=0.6,fr;q=0.5,sk;q=0.4,it;q=0.3,el;q=0.2,und;q=0.1',
    },
  });

  if (this.connection !== null) {
    this.connection.onmessage = e => {
      const data = JSON.parse(e.data);
      if (
        data[0] === 'steam/deposit'
      ) {
        switch (data[1].state) {
          case 'listed':
            break;
          case 'withdrawn':
            confirmTrade(data[1].ref).then(() => {
              if (offerSentFor.indexOf(data[1].ref) === -1) {
                offerSentFor.push(data[1].ref);
                getDetails(data[1].ref).then(details => {
                  if (config.steam) {
                    sendSteamOffer(details.trade.items[0], details.trade.tradeUrl);
                  }
                  if (config.discord) {
                    sendDiscord(`<@${config.discordUserId}> Deposit offer for ${details.trade.items[0].name} accepted`);
                    console.log(`Deposit offer for ${details.trade.items[0].name} accepted`);
                  }
                });
              }
            }).catch(err => {
              console.log(err);
              // something went wrong
            });
            break;
        }
      }
      // console.log(e);
    }
  }
}

init();

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
  134567
];

function sendSteamOffer(sendItem, tradeUrl) {
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
        appid: item.appid,
        contextid: item.contextid,
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

function sendDiscord(msg) {
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
function getInventory(steamId, appId) {
  return new Promise((resolve, reject) => {
    manager.getUserInventoryContents(steamId, appId, 2, true, function (err, inventory, currency) {
      if (inventory) {
        resolve(inventory);
      } else {
        resolve([]);
      }
    });
  });
}