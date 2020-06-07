/* eslint-disable consistent-return */
/* eslint-disable no-restricted-syntax */
/* eslint-disable guard-for-in */
/* eslint-disable no-param-reassign */
/* eslint-disable no-prototype-builtins */
/* eslint-disable @typescript-eslint/no-use-before-define */

import {
  app,
  ipcMain,
  screen,
  shell,
  IpcMainEvent,
} from 'electron';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as querystring from 'querystring';

import * as request from 'request';
import * as semver from 'semver';
import * as winston from 'winston';

import * as wsServer from '@webcrypto-local/server';
import type { Cards } from '@webcrypto-local/cards';

// PKI
import * as application from './application';
import { ConfigureWrite, ConfigureRead } from './config';
import {
  APP_CARD_JSON, APP_CARD_JSON_LINK, APP_CONFIG_FILE, APP_DIR, APP_SSL_CERT,
  APP_SSL_KEY, APP_USER_DIR, CHECK_UPDATE, CHECK_UPDATE_INTERVAL,
  SUPPORT_NEW_TOKEN_LINK, TEMPLATE_NEW_CARD_FILE, APP_LOG_FILE,
} from './const';
import * as appCrypto from './crypto';
import * as jws from './jws';
import { Locale, locale, intl } from './locale';
import * as services from './services';
import * as tray from './tray';
import { CheckUpdate } from './update';
import {
  CreateErrorWindow,
  CreateQuestionWindow,
  CreateWarningWindow,
  CreateMainWindow,
  CreateKeyPinWindow,
  CreateP11PinWindow,
  CreateTokenWindow,
} from './windows';

require('@babel/polyfill');

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
}

if (!fs.existsSync(APP_USER_DIR)) {
  fs.mkdirSync(APP_USER_DIR);
}

printInfo();

if ('dock' in app) {
  app.dock.hide();
}

app.once('ready', async () => {
  try {
    // #region Load locale
    winston.info(`System locale is '${app.getLocale()}'`);
    if (!application.configure.locale) {
      const localeList = Locale.getLangList();
      const lang = app.getLocale().split('-')[0];
      application.configure.locale = (localeList.indexOf(lang) === -1) ? 'en' : lang;
      // save configure
      ConfigureWrite(APP_CONFIG_FILE, application.configure);
    }
    locale.setLang(application.configure.locale);

    locale.on('change', () => {
      application.configure.locale = locale.lang;
      ConfigureWrite(APP_CONFIG_FILE, application.configure);
    });
    // #endregion

    tray.create();

    CreateMainWindow();

    if (CHECK_UPDATE) {
      await CheckUpdate();
      setInterval(() => {
        CheckUpdate();
      }, CHECK_UPDATE_INTERVAL);
    }

    await InitService();
    InitMessages();
  } catch (error) {
    winston.error(error.toString());
    app.emit('error', error);
  }
});

// Quit when all windows are closed.
// app.on('window-all-closed', function () {
//     // On OS X it is common for applications and their menu bar
//     // to stay active until the user quits explicitly with Cmd + Q
//     if (process.platform !== 'darwin') {
//         app.quit()
//     }
// })

async function InitService() {
  wsServer.setEngine('@peculiar/webcrypto', appCrypto.crypto);
  const sslService = new services.SslService();
  try {
    await sslService.run();
  } catch (e) {
    winston.error(e.toString());

    CreateErrorWindow(intl('error.ssl.install'), () => {
      application.quit();
    });

    application.quit();
  }

  const sslData: wsServer.IServerOptions = {
    cert: fs.readFileSync(APP_SSL_CERT),
    key: fs.readFileSync(APP_SSL_KEY),
  } as any;
  winston.info('SSL certificate is loaded');

  const config: IConfigure = {
    disableCardUpdate: application.configure.disableCardUpdate,
    proxy: '',
    logging: false,
    cards: [],
    providers: [],
  };
  await PrepareConfig(config);
  // console.log(JSON.stringify(config, null, "  "));
  // @ts-ignore
  sslData.config = config;
  sslData.storage = await wsServer.FileStorage.create();

  try {
    application.load(sslData);
  } catch (e) {
    winston.error(e.message);
    winston.error("LocalServer is empty. webcrypto-local module wasn't loaded");

    return;
  }

  const { server } = application;

  server
    .on('listening', (e: any) => {
      winston.info(`Server: Started at ${e}`);
    })
    .on('info', (message) => {
      winston.info(message);
    })
    .on('token_new', (card) => {
      const atr = card.atr.toString('hex');
      winston.info(`New token was found reader: '${card.reader}' ATR: ${atr}`);

      CreateTokenWindow(
        intl('question.new.token'),
        { id: 'question.new.token', showAgain: true },
        (res) => {
          if (res) {
            try {
              const title = `Add support for '${atr}' token`;
              const body = fs.readFileSync(TEMPLATE_NEW_CARD_FILE, { encoding: 'utf8' })
                .replace(/\$\{reader\}/g, card.reader)
                .replace(/\$\{atr\}/g, atr.toUpperCase())
                .replace(/\$\{driver\}/g, crypto.randomBytes(20).toString('hex').toUpperCase());
              const url1 = `${SUPPORT_NEW_TOKEN_LINK}/issues/new?${querystring.stringify({
                title,
                body,
              })}`;
              shell.openExternal(url1);
            } catch (e) {
              winston.error(e.message);
            }
          }
        },
      );
    })
    .on('error', (e: Error) => {
      winston.error(e.stack || e.toString());

      if (e.hasOwnProperty('code') && e.hasOwnProperty('type')) {
        const err = e as wsServer.WebCryptoLocalError;
        const { CODE } = wsServer.WebCryptoLocalError;

        switch (err.code) {
          case CODE.PCSC_CANNOT_START:
            CreateWarningWindow(intl('warn.pcsc.cannot_start'), {
              alwaysOnTop: true,
              title: intl('warning.title.oh_no'),
              buttonLabel: intl('i_understand'),
              id: 'warn.pcsc.cannot_start',
              showAgain: true,
            }, () => {
              // nothing
            });
            break;
          case CODE.PROVIDER_CRYPTO_NOT_FOUND:
            CreateWarningWindow(intl('warn.token.crypto_not_found', err.message), {
              alwaysOnTop: true,
              title: intl('warning.title.oh_no'),
              id: 'warn.token.crypto_not_found',
              showAgain: true,
            });
            break;
          case CODE.PROVIDER_CRYPTO_WRONG:
          case CODE.PROVIDER_WRONG_LIBRARY:
            CreateWarningWindow(intl('warn.token.crypto_wrong', err.message), {
              alwaysOnTop: true,
              title: intl('warning.title.oh_no'),
              id: 'warn.token.crypto_wrong',
              showAgain: true,
            });
            break;
          default:
          // nothing
        }
      }
    })
    .on('notify', (p: any) => {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;

      switch (p.type) {
        case '2key': {
          p.accept = false;

          CreateKeyPinWindow({
            width,
            height,
            p,
          });
          break;
        }
        case 'pin': {
          CreateP11PinWindow({
            p,
          });
          break;
        }
        default:
          throw new Error('Unknown Notify param');
      }
    })
    .on('close', (e: any) => {
      winston.info(`Close: ${e}`);
    });

  server.listen('127.0.0.1:31337');
}

async function PrepareConfig(config: IConfigure) {
  config.cardConfigPath = APP_CARD_JSON;

  if (!config.disableCardUpdate) {
    await PrepareCardJson();
  }

  PrepareProviders(config);
  PrepareCards(config);
}

function PrepareProviders(config: IConfigure) {
  try {
    if (fs.existsSync(APP_CONFIG_FILE)) {
      const json = JSON.parse(fs.readFileSync(APP_CONFIG_FILE).toString());
      if (json.providers) {
        config.providers = json.providers;
      }
    }
  } catch (err) {
    winston.error(`Cannot prepare config data. ${err.stack}`);
  }
}

function PrepareCards(config: IConfigure) {
  try {
    if (fs.existsSync(APP_CONFIG_FILE)) {
      const json = JSON.parse(fs.readFileSync(APP_CONFIG_FILE).toString());
      if (json.cards) {
        config.cards = json.cards.map((card: any) => ({
          name: card.name,
          atr: Buffer.from(card.atr, 'hex'),
          readOnly: card.readOnly,
          libraries: card.libraries,
        }));
      }
    }
  } catch (err) {
    winston.error(`Cannot prepare config data. ${err.stack}`);
  }
}

async function PrepareCardJson() {
  try {
    if (!fs.existsSync(APP_CARD_JSON)) {
      // try to get the latest card.json from git
      try {
        const message = await GetRemoteFile(APP_CARD_JSON_LINK);

        // try to parse
        const card: Cards = await jws.GetContent(message);

        // copy card.json to .fortify
        fs.writeFileSync(APP_CARD_JSON, JSON.stringify(card, null, '  '), { flag: 'w+' });
        winston.info(`card.json v${card.version} was copied to .fortify from ${APP_CARD_JSON_LINK}`);

        return;
      } catch (err) {
        winston.error(`Cannot get card.json from ${APP_CARD_JSON_LINK}. ${err.stack}`);
      }

      // get original card.json from webcrypto-local
      // eslint-disable-next-line global-require
      const original: Cards = require('@webcrypto-local/cards/lib/card.json');
      fs.writeFileSync(APP_CARD_JSON, JSON.stringify(original, null, '  '), { flag: 'w+' });
      winston.info(`card.json v${original.version} was copied to .fortify from modules`);
    } else {
      // compare existing card.json version with remote
      // if remote version is higher then upload and remove local file
      winston.info('Comparing current version of card.json file with remote');

      let remote: Cards | undefined;

      try {
        const jwsString = await GetRemoteFile(APP_CARD_JSON_LINK);
        remote = await jws.GetContent(jwsString);
      } catch (e) {
        winston.error(`Cannot get get file ${APP_CARD_JSON_LINK}. ${e.message}`);
      }

      const local: Cards = JSON.parse(
        fs.readFileSync(APP_CARD_JSON, { encoding: 'utf8' }),
      );

      if (remote && semver.lt(local.version || '0.0.0', remote.version || '0.0.0')) {
        // copy card.json to .fortify
        fs.writeFileSync(APP_CARD_JSON, JSON.stringify(remote, null, '  '), { flag: 'w+' });
        winston.info(`card.json v${remote.version} was copied to .fortify from ${APP_CARD_JSON_LINK}`);
      } else {
        winston.info(`card.json has the latest version v${local.version}`);
      }
    }
  } catch (err) {
    winston.error(`Cannot prepare card.json data. ${err.stack}`);
  }
}

async function GetRemoteFile(link: string, encoding = 'utf8') {
  const config = ConfigureRead(APP_CONFIG_FILE);
  const options: request.CoreOptions = {
    encoding,
  };
  if (config.proxy) {
    options.proxy = config.proxy;
  }

  return new Promise<string>((resolve, reject) => {
    request.get(link, options, (error, response, body) => {
      if (error) {
        reject(error);
      } else {
        resolve(body);
      }
    });
  });
}

interface CurrentIdentity {
  origin: string | null;
  created: Date | null;
  browsers: string[];
}

function InitMessages() {
  ipcMain
    .on('2key-list', (event: IpcMainEvent) => {
      let storage: wsServer.FileStorage;

      Promise.resolve()
        .then(() => {
          storage = application.server.server.storage as wsServer.FileStorage;
          if (!Object.keys(storage.remoteIdentities).length) {
            // NOTE: call protected method of the storage
            // @ts-ignore
            return storage.loadRemote();
          }
        })
        .then(() => {
          const identities = storage.remoteIdentities;
          const preparedList = [];

          for (const i in identities) {
            const identity = PrepareIdentity(identities[i]);

            preparedList.push(identity);
          }

          // sort identities
          preparedList.sort((a, b) => {
            if (a.origin > b.origin) {
              return 1;
            } if (a.origin < b.origin) {
              return -1;
            }
            if (a.browser > b.browser) {
              return 1;
            } if (a.browser < b.browser) {
              return -1;
            }

            return 0;
          });
          // prepare data
          const res: CurrentIdentity[] = [];
          let currentIdentity: CurrentIdentity = {
            origin: null,
            created: null,
            browsers: [],
          };

          preparedList.forEach((identity) => {
            if (currentIdentity.origin !== identity.origin) {
              if (currentIdentity.origin !== null) {
                res.push(currentIdentity);
              }
              currentIdentity = {
                origin: identity.origin,
                created: identity.created,
                browsers: [identity.browser],
              };
            } else {
              if (currentIdentity.created! > identity.created) {
                currentIdentity.created = identity.created;
              }
              if (!currentIdentity.browsers.some((browser) => browser === identity.browser)) {
                currentIdentity.browsers.push(identity.browser);
              }
            }
          });

          if (currentIdentity.origin !== null) {
            res.push(currentIdentity);
          }

          event.sender.send('2key-list', res);
        });
    })
    .on('2key-remove', (event: IpcMainEvent, arg: any) => {
      const storage = application.server.server.storage as wsServer.FileStorage;

      CreateQuestionWindow(
        intl('question.2key.remove', arg),
        { parent: application.windows.settings },
        (result) => {
          if (result) {
            winston.info(`Removing 2key session key ${arg}`);
            const remList = [];

            for (const i in storage.remoteIdentities) {
              const identity = storage.remoteIdentities[i];
              if (identity.origin === arg) {
                remList.push(i);
              }
            }

            remList.forEach((item) => {
              delete storage.remoteIdentities[item];
            });
            storage.removeRemoteIdentity(arg);

            event.sender.send('2key-remove', arg);
          }
        },
      );
    })
    .on('logging-open', () => {
      shell.openItem(APP_LOG_FILE);
    })
    .on('logging-status', (event: IpcMainEvent) => {
      event.sender.send('logging-status', application.configure.logging);
    })
    .on('logging-status-change', (event: IpcMainEvent) => {
      application.configure.logging = !application.configure.logging;

      ConfigureWrite(APP_CONFIG_FILE, application.configure);
      application.LoggingSwitch(application.configure.logging);

      event.sender.send('logging-status', application.configure.logging);
    })
    .on('language-change', (event: IpcMainEvent, lang: string) => {
      locale.setLang(lang);
      tray.create();

      event.sender.send('language-change', locale.lang);
    })
    .on('language-get', (event: IpcMainEvent) => {
      event.sender.send('language-get', locale.lang);
    })
    .on('error', (event: IpcMainEvent) => {
      winston.error(event.toString());
    });
}

interface Identity {
  browser: string;
  userAgent: string;
  created: Date;
  id: string;
  origin: string | 'edge' | 'ie' | 'chrome' | 'safari' | 'firefox' | 'other';
}

/**
 *
 * @param {WebCryptoLocal.RemoteIdentityEx} identity
 */
function PrepareIdentity(identity: wsServer.RemoteIdentity) {
  const userAgent = identity.userAgent!;
  const res: Identity = {} as any;

  if (/edge\/([\d.]+)/i.exec(userAgent)) {
    res.browser = 'edge';
  } else if (/msie/i.test(userAgent)) {
    res.browser = 'ie';
  } else if (/Trident/i.test(userAgent)) {
    res.browser = 'ie';
  } else if (/chrome/i.test(userAgent)) {
    res.browser = 'chrome';
  } else if (/safari/i.test(userAgent)) {
    res.browser = 'safari';
  } else if (/firefox/i.test(userAgent)) {
    res.browser = 'firefox';
  } else {
    res.browser = 'Other';
  }

  res.created = identity.createdAt;
  res.origin = identity.origin!;

  return res;
}

function printInfo() {
  winston.info(`Application started at ${new Date()}`);
  winston.info(`OS ${os.platform()} ${os.arch()} `);

  try {
    const json = fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8');
    const pkg = JSON.parse(json);

    winston.info(`Fortify v${pkg.version}`);
  } catch {
    //
  }
}
