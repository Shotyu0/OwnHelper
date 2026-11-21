// Connects the page to your Firebase project. These values only identify the project, so they're safe to
// publish: who can read and write is enforced by firestore.rules. Set `firebase` to null to keep everything
// in this browser only (handy for trying the app; the PC guardian and watch sync need Firebase).
export default {
  firebase: {
    apiKey: 'AIzaSyBAsTtMW6Wn6W8_-cT7scdCd3kWyaHjrY0',
    authDomain: 'ownhelper.firebaseapp.com',
    projectId: 'ownhelper',
    storageBucket: 'ownhelper.firebasestorage.app',
    messagingSenderId: '163095404411',
    appId: '1:163095404411:web:20a745f65c984e23b4a7de',
  },

  // The Cloudflare Worker in relay/ (shown on the Settings page so you can paste it into HC Webhook).
  relay: null,   // e.g. 'https://personal-helper-relay.<you>.workers.dev'

  // The Korean reader runs on your PC (its language model is ~100 MB, too big for a phone).
  pcReader: 'http://localhost:5057/reader',
};
