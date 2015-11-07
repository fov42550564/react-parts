/*jshint esnext:true, node:true, unused:true */
'use strict';

let fs = require('fs');

function toObject(array, object) {
  array.forEach((element) => { object[element.name] = element; });
  return object;
}

function matcher(prop, partialStore, allKeywords) {
  for (let i = 0; i < allKeywords.length; i++) {
    if (allKeywords[i] instanceof Array) {
      if (partialMatcher(prop, allKeywords[i], partialStore))
        return true;
    } else {
      if (prop.indexOf(allKeywords[i]) != -1)
        return true;
    }
  }
  return false;
}

function partialMatcher(prop, keywords, partialStore) {
  let complete = true;
  for (let i = 0; i < keywords.length; i++) {
    if (prop.indexOf(keywords[i]) != -1) {
      partialStore[keywords[i]] = true;
    }
    complete = complete && partialStore[keywords[i]];
  }
  return complete;
}

// Checks if the component is hosted on GitHub
function isGitHubBased(candidate) {
  return (candidate.repository && candidate.repository.url &&
    candidate.repository.url.indexOf("github.com") != -1);
}

// Check if the given candidate has been modified since a given date
function isModifiedSince(candidate, since) {
  return (candidate.time && candidate.time.modified &&
    new Date(candidate.time.modified) >= since);
}

// Receives an URL to GitHub and returns a shorthand
// (eg: "http://github.com/madebyform/react-parts" becomes "madebyform/react-parts")
function repoUrlToShortRepo(url) {
  return url.replace(/^.*\:\/\//, "") // Remove protocol
    .replace(/\.git(#.+)?$/, "") // Remove .git (and optional branch) suffix
    .replace(/(\w+@)?github\.com[\/\:]/, ""); // Remove domain or ssh clone url
}

// Keep only the component name and its repo
function slimComponentInfo(candidate) {
  return {
    name: candidate.name,
    repo: repoUrlToShortRepo(candidate.repository.url),
    description: candidate.description
  };
}

function parseAndSave(data, decide, callback, options) {
  // Paths to the JSON files with the lists of components
  let nativeComponentsFilename = "./components/react-native.json";
  let webComponentsFilename = "./components/react-web.json";
  let rejectedComponentsFilename = "./components/rejected.json";

  // Load existing components
  let existingNativeComponents = require(nativeComponentsFilename);
  let existingWebComponents = require(webComponentsFilename);
  let rejectedComponents = require(rejectedComponentsFilename);

  // List of all existing components (native, web and rejected)
  let existing = toObject(existingNativeComponents, {});
  toObject(existingWebComponents, existing);
  toObject(rejectedComponents, existing);

  options = options || {};
  let since = options.since || new Date("2010-01-01");

  // Keywords that identify a component for react for web
  // For eg: `['foo', ['bar','baz']]` translates to `foo || (bar && baz)`
  let webKeywords = options.webKeywords || [
    "react-component",
    ["react", "component"],
    // "relay", "graphql", "redux", "flux", "rackt"
  ];

  // Keywords that identify a component for react native
  let nativeKeywords = options.nativeKeywords || [
    "react-native",
    "react-native-component",
    ["react-native", "component"],
    ["react-native", "react-component"],
    ["react", "native"]
  ];

  let webCandidates = [];
  let nativeCandidates = [];

  Object.keys(data).forEach(function(key) {
    let candidate = data[key];
    let webPartialStore = {};
    let nativePartialStore = {};

    // A component is considered if it's hosted on GitHub and matches the given timestamp
    if (!(candidate instanceof Object) || !isModifiedSince(candidate, since) ||
      !isGitHubBased(candidate) || existing[candidate.name]) {
        return;
    }

    // Search for keywords in the `keywords` prop
    if (candidate.keywords && candidate.keywords instanceof Array) {
      if (matcher(candidate.keywords, nativePartialStore, nativeKeywords)) {
        return decide("native", nativeCandidates, candidate, slimComponentInfo);
      }
      if (matcher(candidate.keywords, webPartialStore, webKeywords)) {
        return decide("web", webCandidates, candidate, slimComponentInfo);
      }
    }

    // Search for keywords in the other text props
    for (let prop of ["name", "description", "readme"]) {
      if (candidate[prop]) {
        if (matcher(candidate[prop].toLowerCase(), nativePartialStore, nativeKeywords)) {
          return decide("native", nativeCandidates, candidate, slimComponentInfo);
        }
        if (matcher(candidate[prop].toLowerCase(), webPartialStore, webKeywords)) {
          return decide("web", webCandidates, candidate, slimComponentInfo);
        }
      }
    }

    // Search for keywords inside versions
    if (candidate.versions && candidate.versions instanceof Object) {
      let versions = Object.keys(candidate.versions);

      versions.forEach(function(version) {
        ["dependencies", "peerDependencies", "devDependencies"].forEach(function(prop) {
          if (version[prop]) {
            if (matcher(version[prop], nativePartialStore, nativeKeywords)) {
              return decide("native", nativeCandidates, candidate, slimComponentInfo);
            }
            if (matcher(version[prop], webPartialStore, webKeywords)) {
              return decide("web", webCandidates, candidate, slimComponentInfo);
            }
          }
        });
      });
    }
  });

  // Update the JSON files
  let webComponents = existingWebComponents.concat(webCandidates);
  let nativeComponents = existingNativeComponents.concat(nativeCandidates);
  fs.writeFile(webComponentsFilename, JSON.stringify(webComponents, null, '  '));
  fs.writeFile(nativeComponentsFilename, JSON.stringify(nativeComponents, null, '  '));

  callback(webCandidates, nativeCandidates);
}

// If being executed from the command-line
if (!module.parent) {
  let npmDataFilename = "./data/npm.json";
  let since = new Date(process.argv[2]);
  let options = isNaN(since.getTime()) ? {} : { since };

  let decide = (type, candidates, newCandidate, slim) => candidates.push(slim(newCandidate));

  // Read and parse all the data in the file downloaded from NPM
  fs.readFile(npmDataFilename, "utf8", function (err, data) {
    let json = JSON.parse(data);

    parseAndSave(json, decide, function(webCandidates, nativeCandidates) {

      // Log information about new components that can be used for tweeting
      nativeCandidates.concat(webCandidates).forEach(function(component) {
        let tweet = `🆕 ${ component.name }: <DSC>`;
        let maxLength = 140 - 29 - tweet.length;

        let homepage = `https://github.com/${ component.repo }`;
        let description = `${ component.description }`;

        if (description.length > maxLength) {
          description = description.substring(0, maxLength - 1) + "…";
        } else if (description[description.length - 1] == ".") {
          description = description.substring(0, description.length - 1);
        }
        tweet = tweet.replace("<DSC>", description) + ` ${ homepage }`;
        console.log(tweet);
      });

      console.log(`\nCompleted with ${ webCandidates.length } web components ` +
        `and ${ nativeCandidates.length } native components`);

    }, options);
  });
}

module.exports = parseAndSave;
