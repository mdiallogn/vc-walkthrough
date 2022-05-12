// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Verifiable Credentials Sample

///////////////////////////////////////////////////////////////////////////////////////
// Node packages
var express = require('express')
var session = require('express-session')
var base64url = require('base64url')
var secureRandom = require('secure-random');
var bodyParser = require('body-parser');
var serveIndex = require('serve-index');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const https = require('https')
const url = require('url')
const { SSL_OP_COOKIE_EXCHANGE } = require('constants');
var msal = require('@azure/msal-node');
const fs = require('fs');
const crypto = require('crypto');
const qs = require('qs');

///////////////////////////////////////////////////////////////////////////////////////
// config file can come from command line, env var or the default
var configFile = process.argv.slice(2)[0];
if ( !configFile ) {
  configFile = process.env.CONFIGFILE || './config.json';
}
const config = require( configFile )
if (!config.azTenantId) {
  throw new Error('The config.json file is missing.')
}
module.exports.config = config;

///////////////////////////////////////////////////////////////////////////////////////
// MSAL
var msalConfig = {
  auth: {
      clientId: config.azClientId,
      authority: `https://login.microsoftonline.com/${config.azTenantId}`,
      clientSecret: config.azClientSecret,
  },
  system: {
      loggerOptions: {
          loggerCallback(loglevel, message, containsPii) {
              console.log(message);
          },
          piiLoggingEnabled: false,
          logLevel: msal.LogLevel.Verbose,
      }
  }
};


const cca = new msal.ConfidentialClientApplication(msalConfig);
const msalClientCredentialRequest = {
  scopes: ["3db474b9-6a0c-4840-96ac-1fceb342124f/.default"],
  skipCache: false, 
};
module.exports.msalCca = cca;
module.exports.msalClientCredentialRequest = msalClientCredentialRequest;

///////////////////////////////////////////////////////////////////////////////////////
// Main Express server function
// Note: You'll want to update port values for your setup.
const app = express()
const port = process.env.PORT || 8080;

app.use(bodyParser.urlencoded({ extended: false }));

// Serve static files out of the /public directory
app.use(express.static('public'));

app.use('/.well-known', express.static('.well-known'), serveIndex('.well-known'));

// Set up a simple server side session store.
// The session store will briefly cache issuance requests
// to facilitate QR code scanning.
var sessionStore = new session.MemoryStore();
app.use(session({
  secret: 'cookie-secret-key',
  resave: false,
  saveUninitialized: true,
  store: sessionStore
}))

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Origin, X-Requested-With, Content-Type, Accept");
  next();
});

module.exports.sessionStore = sessionStore;
module.exports.app = app;

function requestTrace( req ) {
  var dateFormatted = new Date().toISOString().replace("T", " ");
  var h1 = '//****************************************************************************';
  //console.log( `${h1}\n${dateFormatted}: ${req.method} ${req.protocol}://${req.headers["host"]}${req.originalUrl}` );
  //console.log( `Headers:`)
  //console.log(req.headers);
}

// echo function so you can test that you can reach your deployment
app.get("/echo",
    function (req, res) {
        requestTrace( req );
        res.status(200).json({
            'date': new Date().toISOString(),
            'api': req.protocol + '://' + req.hostname + req.originalUrl,
            'Host': req.hostname,
            'x-forwarded-for': req.headers['x-forwarded-for'],
            'x-original-host': req.headers['x-original-host']
            });
    }
);



app.get('/.well-known/did-configuration.json', (req, res) => {
    const wellknown = require('./CredentialFiles/did-configuration.json');
    res.send(wellknown);
});

const authConfig = {
  auth: {
      clientId: config.azClientId,
      authority: "https://login.microsoftonline.com/"+config.azTenantId,
      clientSecret: config.azClientSecret
  },
  system: {
      loggerOptions: {
          loggerCallback(loglevel, message, containsPii) {
              console.log(message);
          },
          piiLoggingEnabled: false,
          logLevel: msal.LogLevel.Verbose,
      }
  }
};

const ccaBis = new msal.ConfidentialClientApplication(authConfig);

app.get('/auth', (req, res) => {
 
      const authCodeUrlParameters = {
          scopes: ["user.read"],
          redirectUri: `https://${req.hostname}/auth-callback`,
      };

      // get url to sign user in and consent to scopes needed for application
      ccaBis.getAuthCodeUrl(authCodeUrlParameters).then((response) => {
          res.redirect(response);
      }).catch((error) => console.log(JSON.stringify(error)));
});

app.get('/auth-callback', (req, res) => {
  const tokenRequest = {
      code: req.query.code,
      scopes: ["user.read"],
      redirectUri: `https://${req.hostname}/auth-callback`,
  };

  ccaBis.acquireTokenByCode(tokenRequest).then(async(response) => {
      //console.log("\nResponse: \n:", response);

      const employee = await response.idTokenClaims.name.split(" ");
      const jsonEmployee = {firstName: employee[1], lastName: employee[0]};

      fs.writeFile('public/employees.json', JSON.stringify(jsonEmployee), err => {
     
        // Checking for errors
        if (err) throw err; 
       
        console.log("Done writing"); 
       // res.redirect(getFormattedUrl(req));
       // res.send();
      
      });
      console.log("data :: ", jsonEmployee);
      res.sendFile('public/issuer.html', {root: __dirname})
      //res.sendStatus(200);
  }).catch((error) => {
      console.log(error);
      res.status(500).send(error);
  });
});

// Serve index.html as the home page
app.get('/', function (req, res) { 
    console.log("hostname ::: "+req.hostname);
    requestTrace( req );
    res.sendFile('public/index.html', {root: __dirname});
});

var verifier = require('./verifier.js');
var issuer = require('./issuer.js');
const { hostname } = require('os');

// start server
app.listen(port, () => console.log(`Example issuer app listening on port ${port}!`))