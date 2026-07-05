'use strict';

const { store, FILES_DIR } = require('./store');
const pads = require('./pads');
const files = require('./files');
const users = require('./users');
const invitations = require('./invitations');
const migrate = require('./migrate');

// FTS5 exports surfaced on the db namespace for the /api/search route
const { searchPads, searchSnippet } = pads;

module.exports = {
  store,
  pads,
  files,
  users,
  invitations,
  migrate,
  FILES_DIR,
  searchPads,
  searchSnippet,
};
