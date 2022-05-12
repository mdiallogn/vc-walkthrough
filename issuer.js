// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Verifiable Credentials Issuer Sample

///////////////////////////////////////////////////////////////////////////////////////
// Node packages
var express = require('express')
var session = require('express-session');
var base64url = require('base64url')
var secureRandom = require('secure-random');
var bodyParser = require('body-parser');
// mod.cjs
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const https = require('https');
const url = require('url');
const { SSL_OP_COOKIE_EXCHANGE } = require('constants');
var msal = require('@azure/msal-node');
var uuid = require('uuid');
var mainApp = require('./app.js');
const fs = require('file-system');

var parser = bodyParser.urlencoded({ extended: false });

const MongoClient = require('mongodb').MongoClient;
const dbUrl = "mongodb://127.0.0.1:27017/";
var dbName = null;


  MongoClient.connect(dbUrl, (err, client) => {
    if (err) throw err;
    dbName = client.db("vcdemo");
    console.log("Conneceted with the server !");
  });



///////////////////////////////////////////////////////////////////////////////////////
// Setup the issuance request payload template
//////////// Setup the issuance request payload template
var requestConfigFile = process.argv.slice(2)[1];

if ( !requestConfigFile ) {
  requestConfigFile = process.env.ISSUANCEFILE || './issuance_request_config.json';
}
var issuanceConfig = require( requestConfigFile );
issuanceConfig.registration.clientName = "Node.js SDK API Issuer";
// get the manifest from config.json, this is the URL to the credential created in the azure portal. 
// the display and rules file to create the credential can be found in the credentialfiles directory
// make sure the credentialtype in the issuance payload ma
issuanceConfig.authority = mainApp.config["IssuerAuthority"]
issuanceConfig.issuance.manifest = mainApp.config["CredentialManifest"]
// if there is pin code in the config, but length is zero - remove it. It really shouldn't be there
if ( issuanceConfig.issuance.pin && issuanceConfig.issuance.pin.length == 0 ) {
  issuanceConfig.issuance.pin = null;
}
var apiKey = uuid.v4();
if ( issuanceConfig.callback.headers ) {
  issuanceConfig.callback.headers['api-key'] = apiKey;
}

function requestTrace( req ) {
  var dateFormatted = new Date().toISOString().replace("T", " ");
  var h1 = '//****************************************************************************';
  //console.log( `${h1}\n${dateFormatted}: ${req.method} ${req.protocol}://${req.headers["host"]}${req.originalUrl}` );
  //console.log( `Headers:`)
  //console.log(req.headers);
}

function generatePin( digits ) {
  var add = 1, max = 12 - add;
  max        = Math.pow(10, digits+add);
  var min    = max/10; // Math.pow(10, n) basically
  var number = Math.floor( Math.random() * (max - min + 1) ) + min;
  return ("" + number).substring(add); 
}

const  getFormattedUrl = (req) => {
  return url.format({
      protocol: req.protocol,
      hostname: req.get('host')
  });
}

mainApp.app.get('/api/issuer/get-employee', (req, res) => {
  const employee = require('./public/employees.json');
  console.log("get :: ", employee);
  res.send(employee);
});


mainApp.app.post('/api/issuer/add-employee', (req, res) => {

  const newEmployee = {firstName : req.body.firstName, lastName : req.body.lastName};
  console.log('Employee Name :: ', newEmployee);

  fs.writeFile("./public/employees.json", JSON.stringify(newEmployee), err => {
     
    // Checking for errors
    if (err) throw err; 
   
    // console.log("Done writing"); 
    res.redirect(getFormattedUrl(req));
    res.send();
  
  });
});
/*
 * This method is called from the UI to initiate the issuance of the verifiable credential
 */
mainApp.app.get('/api/issuer/issuance-request', async (req, res) => {
  
  console.log("request trace :: ");
  requestTrace( req );
  var id = req.session.id;
  // prep a session state of 0
  mainApp.sessionStore.get( id, (error, session) => {
    var sessionData = {
      "status" : 0,
      "message": "Waiting for QR code to be scanned"
    };
    if ( session ) {
      session.sessionData = sessionData;
      mainApp.sessionStore.set( id, session);  
    }
  });

  // get the Access Token
  var accessToken = "";
  try {
    const result = await mainApp.msalCca.acquireTokenByClientCredential(mainApp.msalClientCredentialRequest);
    if ( result ) {
      accessToken = result.accessToken;
    }
  } catch {
    console.log( "failed to get access token" );
    res.status(401).json({
        'error': 'Could not acquire credentials to access your Azure Key Vault'
        });  
      return; 
  }
  console.log( `accessToken: ${accessToken}` );

  // modify the callback method to make it easier to debug 
  // with tools like ngrok since the URI changes all the time
  // this way you don't need to modify the callback URL in the payload every time
  // ngrok changes the URI
  issuanceConfig.callback.url = `https://${req.hostname}/api/issuer/issuance-request-callback`;
  // modify payload with new state, the state is used to be able to update the UI when callbacks are received from the VC Service
  issuanceConfig.callback.state = id;
  // check if pin is required, if found make sure we set a new random pin
  // pincode is only used when the payload contains claim value pairs which results in an IDTokenhint
  if ( issuanceConfig.issuance.pin ) {
    issuanceConfig.issuance.pin.value = generatePin( issuanceConfig.issuance.pin.length );
  } 
  // here you could change the payload manifest and change the firstname and lastname

  const employee = require('./public/employees.json');

  issuanceConfig.issuance.claims.given_name = req.body =   employee.firstName; 
  issuanceConfig.issuance.claims.family_name =  req.body = employee.lastName;
  console.log( 'VC Client API Request' );
  console.log("Employees ::: ", employee);  
  var payload = JSON.stringify(issuanceConfig);
  
  const fetchOptions = {
    method: 'POST',
    body: payload,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length.toString(),
      'Authorization': `Bearer ${accessToken}`
    }
  };

 
  var client_api_request_endpoint = `https://beta.eu.did.msidentity.com/v1.0/${mainApp.config.azTenantId}/verifiablecredentials/request`;
  const response = await fetch(client_api_request_endpoint, fetchOptions);
  var resp = await response.json()
  // the response from the VC Request API call is returned to the caller (the UI). It contains the URI to the request which Authenticator can download after
  // it has scanned the QR code. If the payload requested the VC Request service to create the QR code that is returned as well
  // the javascript in the UI will use that QR code to display it on the screen to the user.            
  resp.id = id;                              // add session id so browser can pull status
  if ( issuanceConfig.issuance.pin ) {
    resp.pin = issuanceConfig.issuance.pin.value;   // add pin code so browser can display it
  }
  console.log( 'VC Client API Response' );
  console.log( resp );  
 
  res.status(200).json(resp);       
});

mainApp.app.get('/api/issuer/authentication-request-callback', (req, res) => {
  console.log('auth calback :: ', req.query.code);
  res.send();
})
/**
 * This method is called by the VC Request API when the user scans a QR code and presents a Verifiable Credential to the service
 */
mainApp.app.post('/api/issuer/issuance-request-callback', parser, async (req, res) => {
  var body = '';
  req.on('data', function (data) {
    body += data;
  });
  req.on('end', function () {
    requestTrace( req );
    console.log( body );
    if ( req.headers['api-key'] != apiKey ) {
      res.status(401).json({
        'error': 'api-key wrong or missing'
        });  
      return; 
    }
    var issuanceResponse = JSON.parse(body.toString());
    var message = null;
    // there are 2 different callbacks. 1 if the QR code is scanned (or deeplink has been followed)
    // Scanning the QR code makes Authenticator download the specific request from the server
    // the request will be deleted from the server immediately.
    // That's why it is so important to capture this callback and relay this to the UI so the UI can hide
    // the QR code to prevent the user from scanning it twice (resulting in an error since the request is already deleted)
    if ( issuanceResponse.code == "request_retrieved" ) {
      message = "QR Code is scanned. Waiting for issuance to complete...";
     
      mainApp.sessionStore.get(issuanceResponse.state, (error, session) => {
        var sessionData = {
          "status" : "request_retrieved",
          "message": message
        };
        session.sessionData = sessionData;
        mainApp.sessionStore.set( issuanceResponse.state, session, (error) => {
          res.send();
        });
      })      
    }

    if ( issuanceResponse.code == "issuance_successful" ) {
      message = "Credential successfully issued";
      mainApp.sessionStore.get(issuanceResponse.state, (error, session) => {
        var sessionData = {
          "status" : "issuance_successful",
          "message": message
        };
        session.sessionData = sessionData;
        mainApp.sessionStore.set( issuanceResponse.state, session, (error) => {
          res.send();
        });
      })      
    }

    if ( issuanceResponse.code == "issuance_error" ) {
      mainApp.sessionStore.get(issuanceResponse.state, (error, session) => {
        var sessionData = {
          "status" : "issuance_error",
          "message": issuanceResponse.error.message,
          "payload" :issuanceResponse.error.code
        };
        session.sessionData = sessionData;
        mainApp.sessionStore.set( issuanceResponse.state, session, (error) => {
          res.send();
        });
      })      
    }
    console.log(message);
    
    res.send()
  });  
  res.send()
})
/**
 * this function is called from the UI polling for a response from the AAD VC Service.
 * when a callback is received at the presentationCallback service the session will be updated
 * this method will respond with the status so the UI can reflect if the QR code was scanned and with the result of the presentation
 */
mainApp.app.get('/api/issuer/issuance-response', async (req, res) => {
  var id = req.query.id;
  requestTrace( req );
  mainApp.sessionStore.get( id, (error, session) => {
    if (session && session.sessionData) {
      console.log(`status: ${session.sessionData.status}, message: ${session.sessionData.message}`);
      res.status(200).json(session.sessionData);   
      }
  })
});

const authConfig = {
  auth: {
      clientId: mainApp.config.azClientId,
      authority: "https://login.microsoftonline.com/"+mainApp.config.azTenantId,
      clientSecret: mainApp.config.azClientSecret
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

mainApp.app.get('/api/issuer/authenticate', (req, res) => {
      const authCodeUrlParameters = {
          scopes: ["user.read"],
          redirectUri: `https://${req.hostname}/api/issuer/auth-callback`,
      };

      // get url to sign user in and consent to scopes needed for application
      ccaBis.getAuthCodeUrl(authCodeUrlParameters).then((response) => {
          res.redirect(response);
      }).catch((error) => console.log(JSON.stringify(error)));
});

mainApp.app.get('/api/issuer/auth-callback', (req, res) => {
  const tokenRequest = {
      code: req.query.code,
      scopes: ["user.read"],
      redirectUri: `https://${req.hostname}/api/issuer/auth-callback`,
  };

  ccaBis.acquireTokenByCode(tokenRequest).then((response) => {
      console.log("\nResponse: \n:", response);
      res.sendStatus(200);
  }).catch((error) => {
      console.log(error);
      res.status(500).send(error);
  });
});