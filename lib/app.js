const {promisify} = require('util');

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const wrap = require('wrap-ansi');
const validator = require('validator');
const coinstring = require('coinstring');
const inquirer = require('inquirer');
const colorsys = require('colorsys');
const ejs = require( 'ejs' );
const ejsRenderFileAsync = promisify( ejs.renderFile ).bind( ejs );

const html2ansi = require('./html2ansi.js');
const name = require('./name.js');
const Archive = require('./archive.js');
const ApiKey = require('./apikey.js');
const Cert = require('./cert.js');
const htpasswd = require( './htpasswd.js');
const Config = require('./config.js');
const SplashScreen = require( './splashScreen.js' );
const ansi = require( './ansi.js' );

const features = require('../features.json');

const uaCommentRegexp = /^[a-zA-Z0-9 \.,:_\-\?\/@]+$/; // TODO: look for spec of unsafe chars
const userRegexp = /^[a-zA-Z0-9\._\-]+$/;
const maxWidth = 82;

const keyIds = {
  '000': ['stats'],
  '001': ['stats','watcher'],
  '002': ['stats','watcher','spender'],
  '003': ['stats','watcher','spender','admin']
};

const configArchiveFileName = 'config.7z';
const keyArchiveFileName = 'client.7z';

const prefix = () => {
  return chalk.green('Cyphernode')+': ';
};

const randomColor = () => {
  const hex = colorsys.hslToHex( { h: (Math.random()*360)<<0, s: 50, l: 50 } );
  return hex.substr(1);
};

let prompters = [];
fs.readdirSync(path.join(__dirname, '..','prompters')).forEach((file) => {
  prompters.push(require(path.join(__dirname, '..','prompters',file)));
});

module.exports = class App {

  constructor() {
    this.features = features;

    if( fs.existsSync(path.join('/data', 'exitStatus.sh')) ) {
      fs.unlinkSync(path.join('/data', 'exitStatus.sh'));
    }

    this.splash = new SplashScreen( {
      frameDir: path.join(__dirname, '..', 'splash' ),
      enableFortune: true,
      fortuneChalk: chalk.rgb(115,0,77),
      width: maxWidth,
      fortuneSpacing: 3,
      spacerFormatOpen: '[43;5;16m',
      spacerFormatClose: '[0m'
    } );
  }

  async start( options ) {

    options = options || {};

    this.sessionData = {
      defaultDataDirBase: process.env.DEFAULT_DATADIR_BASE ||  process.env.HOME,
      setupDir: process.env.SETUP_DIR || path.join( process.env.HOME, 'cyphernode' ),
      default_username: process.env.DEFAULT_USER || '',
      gatekeeper_version: process.env.GATEKEEPER_VERSION || 'latest',
      proxy_version: process.env.PROXY_VERSION || 'latest',
      proxycron_version: process.env.PROXYCRON_VERSION || 'latest',
      pycoin_version: process.env.PYCOIN_VERSION || 'latest',
      otsclient_version: process.env.OTSCLIENT_VERSION || 'latest',
      bitcoin_version: process.env.BITCOIN_VERSION || 'latest',
      lightning_version: process.env.LIGHTNING_VERSION || 'latest',
      sparkwallet_version: process.env.SPARKWALLET_VERSION || 'standalone',
      noWizard: !!options.noWizard,
      noSplashScreen: !!options.noSplashScreen,
      lightning_nodename: name.generate(),
      lightning_color: randomColor(),
      installer_cleanup: false,
      devmode: process.env.DEVMODE || false
    };

    if( process.env.VERSION_OVERRIDE==='true' ) {
      // make sure we take the latest images, even when
      // we specified specific versions in the env

      this.sessionData.gatekeeper_version =
        this.sessionData.proxy_version =
          this.sessionData.proxycron_version =
            this.sessionData.pycoin_version =
              this.sessionData.otsclient_version =
                this.sessionData.bitcoin_version =
                  this.sessionData.lightning_version = 'latest';
      this.sessionData.sparkwallet_version = 'standalone'

    }

    await this.setupConfigArchive();

    if( !this.sessionData.noSplashScreen ) {
      await this.splash.show();
    }

    let missingProperties = [];

    if( this.config.validateErrors && this.config.validateErrors.length ) {
      for( let error of this.config.validateErrors ) {
        if( error.keyword === 'required' && error.params && error.params.missingProperty ) {
          missingProperties.push( error.params.missingProperty );
        }
      }
    }

    if( this.sessionData.noWizard && missingProperties.length ) {
      console.log(chalk.bold.red('Unable to migrate client.7z non-interactively. Rerun without the -r option') );
      process.exit(1);
    }

    if( !this.sessionData.noWizard  ) {
      // save gatekeeper key password to check if it changed
      this.sessionData.gatekeeper_clientkeyspassword = this.config.data.gatekeeper_clientkeyspassword;
      if(  missingProperties.length ) {
        this.sessionData.markProperties = missingProperties;
      }
      await this.startWizard();
    }

    await this.processProps();
    await this.writeFiles();
  }

  async setupConfigArchive() {

    this.config = new Config();

    if( !fs.existsSync(this.destinationPath(configArchiveFileName)) ) {
      let r = {};
      process.stdout.write(ansi.clear+ansi.reset);
      while( !r.password0 || !r.password1 || r.password0 !== r.password1 ) {

        if( r.password0 && r.password1 && r.password0 !== r.password1 ) {
          console.log(chalk.bold.red('Passwords do not match')+'\n');
        }

        r = await this.prompt([{
          type: 'password',
          name: 'password0',
          message: prefix()+chalk.bold.blue('Choose your configuration password'),
          filter: this.trimFilter
        },
          {
            type: 'password',
            name: 'password1',
            message: prefix()+chalk.bold.blue('Confirm your configuration password'),
            filter: this.trimFilter
          }]);
      }
      this.sessionData.configurationPassword = r.password0;
    } else {
      try {
        let r = {};
        if( process.env.CFG_PASSWORD ) {
          this.sessionData.configurationPassword = process.env.CFG_PASSWORD;
        } else {
          process.stdout.write(ansi.reset);
          while( !r.password ) {
            r = await this.prompt([{
              type: 'password',
              name: 'password',
              message: prefix()+chalk.bold.blue('Enter your configuration password?'),
              filter: this.trimFilter
            }]);
          }
          this.sessionData.configurationPassword = r.password;
        }
        try {
          await this.config.deserialize(
            this.destinationPath(configArchiveFileName),
            this.sessionData.configurationPassword,
          );

          // store clientkeyspassword in sessionData so it can be retrieved by getDefault
          // and a simple return will not result in a password mismatch
          if( this.config.data.hasOwnProperty('gatekeeper_clientkeyspassword') ) {
            this.sessionData.gatekeeper_clientkeyspassword_c =
              this.config.data.gatekeeper_clientkeyspassword;
          }

        } catch (e) {
          console.log(chalk.bold.red(e));
          process.exit();
        }
      } catch( err ) {
        console.log(chalk.bold.red('config archive is corrupt.'));
        process.exit(1);
      }
    }

    this.config.data.adminhash = await htpasswd(this.sessionData.configurationPassword);

    for( let c of this.features ) {
      c.checked = this.isChecked( 'features', c.value );
    }

  }

  async startWizard() {
    let r = await this.prompt([{
      type: 'confirm',
      name: 'enablehelp',
      message: prefix()+'Enable help?',
      default: this.getDefault( 'enablehelp' ),
    }]);

    this.config.data.enablehelp = r.enablehelp;

    if( this.config.data.enablehelp ) {
      this.help = require('../help.json');
    }

    let prompts = [];

    for( let m of prompters ) {
      let newPrompts = m.prompts(this);

      if( this.sessionData.markProperties &&
          this.sessionData.markProperties.length ) {

        for( let prompt of newPrompts ) {
          if(  this.sessionData.markProperties.indexOf(prompt.name) !== -1  ) {
            prompt.message = prompt.message+' (⚠️'+' new option '+'⚠️'+')';
          }
        }
      }

      prompts = prompts.concat(newPrompts);
    }

    const props = await this.prompt(prompts);

    this.config.data = Object.assign(this.config.data, props);
  }

  async processProps() {

    // creates keys if they don't exist or we say so.
    if( this.config.data.gatekeeper_recreatekeys ||
      this.config.data.gatekeeper_keys.configEntries.length===0 ) {

      delete this.config.data.gatekeeper_recreatekeys;

      let configEntries = [];
      let clientInformation = [];

      for( let keyId in keyIds ) {
        const apikey = await this.createRandomKey( keyId, keyIds[keyId] );
        configEntries.push(apikey.getConfigEntry());
        clientInformation.push(apikey.getClientInformation());
      }

      this.config.data.gatekeeper_keys = {
        configEntries: configEntries,
        clientInformation: clientInformation
      }

    }

    const cert = new Cert();
    this.sessionData.cns = cert.cns(this.config.data.gatekeeper_cns);

    // create certs if they don't exist or we say so.
    if( this.config.data.gatekeeper_recreatecert ||
      !this.config.data.gatekeeper_sslcert ||
      !this.config.data.gatekeeper_sslkey ) {
      delete this.config.data.gatekeeper_recreatecert;
      const cert = new Cert();
      console.log(chalk.bold.green( '☕ Generating gatekeeper cert. This may take a while ☕' ));
      try {
        const result = await cert.create(this.sessionData.cns);
        if( result.code === 0 ) {
          this.config.data.gatekeeper_sslkey = result.key.toString();
          this.config.data.gatekeeper_sslcert = result.cert.toString();
        } else {
          console.log(chalk.bold.red( 'error! Gatekeeper cert was not created' ));
        }
      } catch( err ) {
        console.log(chalk.bold.red( 'error! Gatekeeper cert was not created' ));
      }
    }
  }

  async createRandomKey( id, groups ) {
    if( !id || !groups || !groups.length ) {
      return;
    }
    const apikey = new ApiKey();
    apikey.setId(id);
    apikey.setGroups(groups);
    await apikey.randomiseKey();
    return apikey
  }

  async writeFiles() {

    console.log( chalk.green( '   create' )+' '+configArchiveFileName );
    if( !this.config.serialize(
      this.destinationPath(configArchiveFileName),
      this.sessionData.configurationPassword
    ) ) {
      console.log(chalk.bold.red( 'error! Config archive was not written' ));
    }

    const pathProps = [
      'gatekeeper_datapath',
      'traefik_datapath',
      'proxy_datapath',
      'bitcoin_datapath',
      'lightning_datapath',
      'otsclient_datapath'
    ];

    for( let pathProp of pathProps ) {
      if( this.config.data[pathProp] === '_custom' ) {
        this.config.data[pathProp] = this.config.data[pathProp+'_custom'] || '';
      }
    }

    for( let m of prompters ) {
      const name = m.name();
      for( let t of m.templates(this.config.data) ) {
        const p = path.join(name,t);
        const destFile = this.destinationPath(p);
        const targetDir = path.dirname( destFile );

        if( !fs.existsSync(targetDir) ) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        const result = await ejsRenderFileAsync( this.templatePath(p), Object.assign({},this.config.data,this.sessionData), {} );

        console.log( chalk.green( '   create' )+' '+p );
        fs.writeFileSync( destFile, result );

      }
    }

    console.log( chalk.green( '   create' )+' '+keyArchiveFileName );

    if( this.config.data.gatekeeper_keys && this.config.data.gatekeeper_keys.clientInformation ) {

      if( this.sessionData.gatekeeper_clientkeyspassword !== this.config.data.gatekeeper_clientkeyspassword &&
          fs.existsSync(this.destinationPath(keyArchiveFileName)) ) {
        fs.unlinkSync( this.destinationPath(keyArchiveFileName) );
      }

      const archive = new Archive( this.destinationPath(keyArchiveFileName), this.config.data.gatekeeper_clientkeyspassword );
      if( !await archive.writeEntry( 'keys.txt', this.config.data.gatekeeper_keys.clientInformation.join('\n') ) ) {
        console.log(chalk.bold.red( 'error! Client gatekeeper key archive was not written' ));
      }
      if( !await archive.writeEntry( 'cacert.pem', this.config.data.gatekeeper_sslcert ) ) {
        console.log(chalk.bold.red( 'error! Client gatekeeper key archive was not written' ));
      }
    }

    fs.writeFileSync(path.join('/data', 'exitStatus.sh'), 'EXIT_STATUS=0');

  }

  async prompt( questions ) {
    if( !questions ) {
      return {};
    }

    const r = await inquirer.prompt( questions );
    return r;
  }

  /* some utils */

  destinationPath( relPath ) {
    return path.join( '/data', relPath );
  }

  templatePath( relPath ) {
    return path.join(__dirname, '..','templates',relPath );
  }

  isChecked(name, value ) {
    return this.config.data && this.config.data[name] && this.config.data[name].indexOf(value) != -1 ;
  }

  getDefault(name) {

    if( this.config && this.config.data && this.config.data.hasOwnProperty(name) ) {
      return this.config.data[name];
    }

    if( this.sessionData && this.sessionData.hasOwnProperty(name) ) {
      return this.sessionData[name];
    }

  }

  optional(input, validator) {
    if( input === undefined ||
        input === null ||
        input === '' ) {
      return true;
    }
    return validator(input);
  }

  ipOrFQDNValidator(host ) {
    host = (host+"").trim();
    if( !(validator.isIP(host) ||
      validator.isFQDN(host)) ) {
      throw new Error( 'No IP address or fully qualified domain name' )
    }
    return true;
  }

  xkeyValidator(xpub ) {
    // TOOD: check for version
    if( !coinstring.isValid( xpub ) ) {
      throw new Error('Not an extended key.');
    }
    return true;
  }

  pathValidator(p ) {
    return true;
  }

  derivationPathValidator(path ) {
    return true;
  }

  colorValidator(color) {
    if( !validator.isHexadecimal(color) ) {
      throw new Error('Not a hex color.');
    }
    return true;
  }

  lightningNodeNameValidator(name) {
    if( !name || name.length > 32 ) {
      throw new Error('Please enter anything shorter than 32 characters');
    }
    return true;
  }

  notEmptyValidator(path ) {
    if( !path ) {
      throw new Error('Please enter something');
    }
    return true;
  }

  usernameValidator(user ) {
     if( !userRegexp.test( user ) ) {
      throw new Error('Choose a valid username');
    }
    return true;
  }

  UACommentValidator(comment ) {
    if( !uaCommentRegexp.test( comment ) ) {
      throw new Error('Unsafe characters in UA comment. Please use only a-z, A-Z, 0-9, SPACE and .,:_?@');
    }
    return true;
  }

  trimFilter(input ) {
    return (input+"").trim();
  }

  featureChoices() {
    return this.features;
  }

  setupDir() {
    return this.sessionData.setupDir;
  }

  defaultDataDirBase() {
    return this.sessionData.defaultDataDirBase;
  }

  getHelp(topic ) {
    if( !this.config.data.enablehelp || !this.help ) {
      return '';
    }

    const helpText = this.help[topic] || this.help['__default__'];

    if( !helpText ||helpText === '' ) {
      return '';
    }

    return "\n\n"+wrap( html2ansi(helpText),maxWidth )+"\n\n";
  }

};
