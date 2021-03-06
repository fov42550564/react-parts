/*jshint esnext:true, node:true */
'use strict';

let path = require('path');
let webpack = require('webpack');
let production = (process.env.NODE_ENV == "production");
let Config = {};

Config.common = function() {
  return {
    output: {
      path: path.resolve("./assets"),
      filename: "app.js",
      publicPath: "/"
    },
    entry: [
      "./src/app.jsx"
    ],
    module: {
      loaders: [{
        test: /\.jsx?$/,
        loader: "babel",
        include: path.resolve("./src")
      }]
    },
    plugins: [
      new webpack.DefinePlugin({ __DEV__: JSON.stringify(!production) })
    ]
  };
};

Config.production = function() {
  let config = Object.assign({}, Config.common());

  config.plugins.push(
    new webpack.optimize.OccurenceOrderPlugin(),
    new webpack.DefinePlugin({
      'process.env': {
        'NODE_ENV': JSON.stringify('production')
      }
    }),
    new webpack.optimize.UglifyJsPlugin({
      compressor: {
        warnings: false
      }
    })
  );

  config.output.filename = "app.min.js";

  return config;
};

Config.development = function() {
  let config = Object.assign({}, Config.common(), {
    devtool: 'eval'
  });

  config.plugins.push(
    /* Plugins required by webpack-hot-middleware */
    new webpack.HotModuleReplacementPlugin(), // Hot module replacement
    new webpack.NoErrorsPlugin() // No errors is used to handle errors more cleanly
  );

  // Add new client that allows connection to the server to receive notifications
  // when the bundle rebuilds and then updates the app bundle accordingly
  config.entry.push("webpack-hot-middleware/client");

  // Add configs to the babel loader for react-transform (git.io/vWzwN)
  config.module.loaders[0].query = {
    plugins: ["react-transform"],
    extra: {
      "react-transform": {
        "transforms": [{
          "transform": "react-transform-hmr",
          "imports": ["react"],
          "locals": ["module"]
        }, {
          "transform": "react-transform-catch-errors",
          "imports": ["react", "redbox-react"]
        }]
      }
    }
  };

  return config;
};

module.exports = production ? Config.production() : Config.development();
