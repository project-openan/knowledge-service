const path = require('path');

process.env.VUE_APP_KBASE_BASE ||= '/api/knowledge-service/v1'
process.env.VUE_APP_WORKFLOW_BASE ||= process.env.VUE_APP_KBASE_BASE
process.env.VUE_APP_QUERY_BASE ||= process.env.VUE_APP_KBASE_BASE
process.env.VUE_APP_ROUTE_MODE ||= 'hash'

const publicPath = process.env.BASE_URL

function resolve (dir) {
  return path.join(__dirname, dir)
}
// 打包时间戳
process.env.VUE_APP_TIME_STAMP = new Date().getTime()
const isDevelopment = process.env.VUE_APP_ENV === 'development'

// 浏览器标签标题：填产品名，保证独立部署时 document.title 不为空。
// 运行时的兜底与 `<html lang>` 见 src/app/main.js。
const title = 'Knowledge Studio'
const pages = {
  app: {
    entry: 'src/app/main.js',
    template: 'public/index.html',
    // 在 dist/index.html 的输出
    filename: 'index.html',
    // 当使用 title 选项时，
    // template 中的 title 标签需要是 <title><%= htmlWebpackPlugin.options.title %></title>
    title: title,
  }
}

const _legacyConfig_ = {
  publicPath,
  pages,
  configureWebpack: config => {
    if (isDevelopment) {
      config.devtool = 'eval-source-map'
    }
    return {
      output: {
        library: 'ai',
        // 将你的 library 暴露为所有的模块定义下都可运行的方式
        libraryTarget: 'umd',
        // 按需加载相关，设置为 webpackJsonp_saasApp 即可
        // jsonpFunction: 'webpackJsonp_saas' // webpack 4
        chunkLoadingGlobal: 'webpackJsonp_ai'
      },
      plugins: [
        // new CopyWebpackPlugin()
      ],
      // optimization:{
      //   minimize: false
      // },
      resolve: {
        alias: {
          '@': resolve('./src')
        }
      },
    }
  },
  // transpileDependencies: [/node_modules\/json[^/]+/, /node_modules\/vanilla-jsoneditor/],
  transpileDependencies: [/node_modules/],
  chainWebpack: config => {
    config
      // .plugin('html')
      .plugin('html-app')
      .tap(args => args)
  },
  lintOnSave: 'warning',
  productionSourceMap: process.env.NODE_ENV !== 'production',
  devServer: {
    host: 'localhost',
    port: 8808,
    server: 'http',
    allowedHosts: "all",
    client: {
      overlay: false
    },
    proxy: devProxy()
  }
}

// Keep the browser host for the backend's origin check.
function devProxy () {
  const target = process.env.VUE_APP_API || 'http://127.0.0.1:8091'
  return { [process.env.VUE_APP_KBASE_BASE]: { target, changeOrigin: false } }
}

module.exports = (function (config) {

  function filter(config) {
    config.lintOnSave = false
    let webpackConfig = config.chainWebpack
    config.chainWebpack = (config) => {
      config.module
        .rule('vue')
        .use('vue-loader')
        .tap((options) => {
          return {
            ...options,
            // compilerOptions: {
            //   compatConfig: {
            //     MODE: 2
            //   }
            // }
          }
        })
      if (typeof webpackConfig === 'function') {
        webpackConfig(config)
      }

      // vue3 全家桶别名

    }
    return config
  }

  return function (...args) {
    let _config
    if (typeof config === 'function') {
      _config = config(...args)
    } else {
      _config = config
    }
    return (_config instanceof Promise) ? _config.then(config => filter(config)) : filter(_config)
  }
}(_legacyConfig_))
