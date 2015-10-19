/*jshint esnext:true, node:true, unused:true */
'use strict';

let fs = require('fs');
let co = require("co");
let request = require("co-request");
let keys = require('./keys.json');

// Pass the components list you which to update ("react" or "react-native")
let componentsType = process.argv[2] || "react-native";
let componentsFile = `./components/${ componentsType }.json`;
let components = require(componentsFile);

// Load the existing data file, with all the existing metadata
let componentsDataFile = `./data/${ componentsType }.json`;
let oldComponentsData = [];

try { oldComponentsData = require(componentsDataFile); }
catch (e) { console.log(`Creating a new data file for ${ componentsType }.`); }

// Load rejected components. Rejected components will be removed from the data files
let rejectedComponents = toObject(require('./components/rejected.json'), {});

// Load existing documentation
let docsFile = "./data/docs.json";
let docs = {};

try { docs = require(docsFile); }
catch (e) { console.log(`Creating a new data file for ${ docsFile }.`); }

// We'll fetch metadata from NPM, GitHub and NPM-Stat
let endpoints = {
  npm: "https://registry.npmjs.com/",
  github: "https://api.github.com/repos/",
  npmStat: "http://npm-stat.com/downloads/range/"
};

function toObject(array, object) {
  array.forEach((element) => { object[element.name] = element; });
  return object;
}

function isDoubleByte(str) {
  for (var i = 0, n = str.length; i < n; i++) {
    if (str.charCodeAt( i ) > 255) { return true; }
  }
  return false;
}

let currentTime = new Date().toISOString().substr(0, 10), startTime;
let promises = [], options = {};

// Example usage: `npm run fetch react-web 2`
// This will make a partial update to the data file
if (process.argv[3]) {
  let interval = 50;
  let sliceArg = parseInt(process.argv[3]); // Eg: 2
  let sliceStart = sliceArg * interval - interval; // 50
  let sliceEnd   = sliceArg * interval; // 100
  components = components.slice(sliceStart, sliceEnd);
}

components.forEach(function(component) {
  promises.push(
    new Promise(function(resolve) {
      co(function* () {
        options = {
          url: endpoints.npm + component.name,
          json: true
        };
        let npm = (yield request(options)).body;

        options = {
          url: endpoints.github + component.repo,
          headers: { 'User-Agent': 'request' },
          auth: { 'user': keys.github.username, 'pass': keys.github.password },
          json: true
        };
        let github = (yield request(options)).body;

        startTime = new Date(npm.time.created).toISOString().substr(0,10);
        options = {
          url: `${ endpoints.npmStat }${ startTime }:${ currentTime }/${ component.name }`,
          json: true
        };
        let stat = (yield request(options)).body;

        let data = {
          name:        component.name,
          githubUser:  component.repo.split("/")[0],
          githubName:  component.repo.split("/")[1],
          description: (npm.description || "").trim(),
          keywords:    (npm.versions[npm["dist-tags"].latest].keywords || []).join(", "),
          modified:    npm.time.modified,
          stars:       github.stargazers_count,
          downloads:   (stat.downloads || [{ downloads: 0 }]).reduce((total, daily) => total + daily.downloads, 0),
          latestVersion: npm["dist-tags"].latest
        };

        // Log if the new data doesn't have stars information or a description
        if (typeof data.stars === 'undefined') console.log(`Component ${ component.name } has no stars`);
        if (!data.description) console.log(`Component ${ component.name } has no description`);

        // To save some bytes, if package name and repo name are equal, keep only one
        if (data.name === data.githubName) delete data.githubName;

        // Check if our custom description should be used instead
        if (component.custom_description) {
          if (component.description != data.description) { // Check if our custom_description is outdated
            console.log(`Component ${ component.name } has a new description: '${ data.description }'`);
          } else {
            data.description = component.custom_description; // Use our custom description
          }
        }

        // Add a trailing dot to the description
        if (!/[\.\?\!]$/.test(data.description) && !isDoubleByte(data.description)) {
          data.description += ".";
        }

        // If it's a react native component, check which platforms it has specific code for
        if (componentsType == "react-native") {
          options = {
            url: `${ endpoints.github }${ component.repo }/languages`,
            headers: { 'User-Agent': 'request' },
            auth: { 'user': keys.github.username, 'pass': keys.github.password },
            json: true
          };
          let languages = (yield request(options)).body;

          if (languages.Java) {
            data.platforms = { android: true };
          }
          if (languages['Objective-C']) {
            data.platforms = data.platforms || {};
            data.platforms.ios = true;
          }

          // Some older packages may be JavaScript only, and work in Android, but have just the "ios" keyword.
          // So only if there's Java or Objective-C code in the repo, we should check the keywords too.
          if (data.platforms && /iOS|Android/i.test(`${ data.keywords }`)) {
            // CLIs generate boilerplate code for both platforms, so using languages is unreliable.
            // However, using only the keywords here doesn't give better results either.
            // The best results were obtained when we used both approaches.
            if (/Android/i.test(data.keywords)) {
              data.platforms.android = true;
            }
            if (/iOS/i.test(data.keywords)) {
              data.platforms.ios = true;
            }
          }
        }

        // Save the content of the readme file, if it's markdown
        saveReadme(component, npm);

        resolve(data);
        process.stdout.write(".");

      }).catch(function() {
        process.stdout.write(` Problems with data for: ${ component.name } `);
        resolve(component);
      });
    })
  );
});

Promise.all(promises).then(function(newData) {
  let allData = {}, newList = [];

  // Merge old fetched data with the new one, since we may have done a
  // partial fetch this time
  oldComponentsData.concat(newData).forEach(function(c) {
    allData[c.name] = c;
  });

  // Convert back to an array and make sure we ignore rejects
  Object.keys(allData).forEach(function(key) {
    if (!rejectedComponents[key]) newList.push(allData[key]);
  });

  // Persist the new data
  let str = JSON.stringify(newList);
  fs.writeFile(componentsDataFile, str);

  // Persist the new docs
  str = JSON.stringify(docs, null, '  ');
  fs.writeFile(docsFile, str);

  console.log("\nSuccess!");
});


/* Additional work for storing and rendering readme files */

let marked = require('marked');
let marky = require("marky-markdown");
let hljs = require("highlight.js");

// Apply syntax highlighting to fenced code blocks using the highlight plugin
marked.setOptions({
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(lang, code).value;
    }
    return hljs.highlightAuto(code).value;
  },
  langPrefix: "hljs language-"
});

/*
 * Aspects of GitHub Flavored Markdown (git.io/vCAcc) we should support:
 * - Multiple underscores in words (eg: wow_great_stuff) enabled by default by markdown-it
 * - URL autolinking works by using the `linkify` markdown-it option
 * - Strikethrough fenced code blocks and tables enabled by default by markdown-it
 */
marked.setOptions({
  gfm: true,
  tables: true,
  breaks: false,
  pedantic: false,
  sanitize: false,
  smartLists: true,
  smartypants: true,
  renderer: new marked.Renderer()
});

let markyOptions = {
  sanitize: false,           // False in order to keep ~~strike~~ and <sup> (git.io/vCAUj)
  highlightSyntax: false,    // Run highlights on code blocks. We use highlight.js instead
  prefixHeadingIds: false,   // Prevent DOM id collisions
  serveImagesWithCDN: false, // Use npm's CDN to proxy images over HTTPS
  debug: false,              // console.log() all the things

  // We can't override the options `marky-markdown` sends down to `markdown-it`.
  // We are using a fork that enables us to pass a `renderer` option.
  // We can pass an instance of `markdown-it` or anything else that has a `render` method.
  renderer: { render(html) { return marked(html); } }
};

// Fix bug on Marked that doesn't support `#Testing` on GFM (see git.io/vCFe8)
marked.Lexer.rules.gfm.heading = marked.Lexer.rules.normal.heading;
marked.Lexer.rules.tables.heading = marked.Lexer.rules.normal.heading;

// Add support for Github Task Lists
function setGithubTaskLists($) {
  let input, $el, html, match,
    changed = false,
    regex = /^(<p>)?(\[[\sx]\])/i;

  $("li").each(function(i, el) {
    $el = $(el);
    html = $el.html();
    match = html.match(regex);
    match = match ? match[2] : "";

    if (match.toLowerCase() === "[x]") {
      input = '<input type="checkbox" class="task-list-item-checkbox" disabled checked>';
    } else if (match === "[ ]") {
      input = '<input type="checkbox" class="task-list-item-checkbox" disabled>';
    } else {
      return;
    }

    html = html.replace(regex, `$1${ input }`);
    $el.html(html);
    $el.addClass("task-list-item");
    $el.parent("ul").addClass("task-list");

    changed = true;
  });

  // When there are nested task lists, changes are lost. Recursively call this function
  // until all task lists have been transformed. TODO Improve this code.
  if (changed) return setGithubTaskLists($);

  return $;
}

function saveReadme(component, npm) {
  // Don't continue if readme is not written in markdown
  if (!/\.md$/.test(npm.readmeFilename) || npm.readme == "ERROR: No README data found!") {
    // console.log(`No README available for ${ component.name }`);

    let home = `https://github.com/${ component.repo }`;
    npm.readme = `No documentation is available for this component. You may find it on ` +
      `[GitHub](${ home }).  \nIf the repository doesn't have a README file, ` +
      `consider helping the community by [writing one](${ home }/new/master?readme=1).`;
  }

  // npm package metadata to rewrite relative URLs, etc.
  markyOptions.package = {
    name: component.name,
    description: component.description,
    repository: {
      type: "git",
      url: `https://github.com/${ component.repo }`
    }
  };

  // Render and save it to persist it later
  var $html = marky(npm.readme, markyOptions);
  docs[component.name] = setGithubTaskLists($html).html();
}