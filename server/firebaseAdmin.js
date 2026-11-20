const admin = require("firebase-admin");

function initFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) {
    throw new Error("Falta la variable FIREBASE_SERVICE_ACCOUNT_JSON en Vercel.");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawJson);
  } catch (err) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON no es un JSON válido: " + err.message);
  }

  if (serviceAccount.private_key && typeof serviceAccount.private_key === "string") {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  return admin;
}

function getDb() {
  return initFirebaseAdmin().firestore();
}

function getAuth() {
  return initFirebaseAdmin().auth();
}

module.exports = { admin, initFirebaseAdmin, getDb, getAuth };
