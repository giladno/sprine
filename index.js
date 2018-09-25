'use strict';
const path = require('path');
const express = require('express');
const klaw = require('klaw-sync');

const require_all = dirname =>
    klaw(dirname, {
        nodir: true,
        depthLimit: -1,
    })
        .map(f => f.path)
        .filter(filename => !path.basename(filename).startsWith('_'))
        .sort()
        .reduce(
            (files, filename) =>
                Object.assign(files, {[path.relative(dirname, filename).replace(/\.js$/i, '')]: require(filename)}),
            {}
        );

module.exports = (opt, init) => {
    if (typeof opt == 'function') {
        init = opt;
        opt = {};
    }
    opt = {
        dev: process.env.NODE_ENV == 'development',
        morgan: 'dev',
        json: true,
        urlencoded: {extended: true},
        ...(opt || {}),
    };
    const app = opt.app || express();
    if (opt.proxy) app.set('trust proxy', true);
    if (opt.engine) {
        app.set('view engine', opt.engine);
        if (opt.views) app.set('views', opt.views);
    }
    if (opt.sequelize) {
        const Sequelize = require('sequelize');
        const sequelize = new Sequelize(...[].concat(opt.sequelize));
        for (const model of Object.values(require_all(opt.models || path.resolve(process.cwd(), './models')))) {
            model(sequelize, Sequelize);
        }
        for (const model of sequelize.models) {
            if (model.associate) model.associate(sequelize.models);
        }
        app.set('db', sequelize);
        app.set('models', sequelize.models);
    }
    if (opt.cors) app.use(require('cors')(typeof opt.cors == 'object' ? opt.cors : {}));
    if (opt.static) {
        const {root, prefix, ..._opt} = typeof opt.static == 'string' ? {root: opt.static} : opt.static;
        app.use(...[].concat(prefix || [], express.static(root, _opt)));
    }
    if (opt.dev && opt.morgan) app.use(require('morgan')(opt.morgan));
    if (opt.keys || opt.session)
        app.use(require('cookie-session')({keys: [].concat(opt.keys || []), ...(opt.session || {})}));
    if (opt.json) app.use(express.json(typeof opt.json == 'object' ? opt.json : {}));
    if (opt.urlencoded) app.use(express.urlencoded(typeof opt.urlencoded == 'object' ? opt.urlencoded : {}));
    if (opt.authenticate) {
        app.use(async (req, res, next) => {
            let user = await opt.authenticate(req.session);
            if (user) res.locals.user = req.user = user;
            next();
        });
    }

    if (init) init(app);

    if (opt.controllers) {
        const multer = opt.multer && require('multer')(typeof opt.multer == 'object' ? opt.multer : {});
        for (const [prefix, controller] of Object.entries(require_all(opt.controllers))) {
            app.use(
                ...[].concat(
                    prefix != 'index' ? `/${prefix.replace(/\/index$/i, '')}` : [],
                    controller.cors ? require('cors')(typeof controller.cors == 'object' ? controller.cors : {}) : [],
                    (controller.multer && controller.multer(multer)) || [],
                    controller.authenticate && typeof controller.authenticate != 'function'
                        ? (req, res, next) => {
                              if (!req.user) return res.status(401).end();
                              next();
                          }
                        : controller.authenticate || [],
                    controller.authorize && typeof controller.authorize != 'function'
                        ? async (req, res, next) => {
                              if (!opt.authorize(req, controller.authorize)) return res.status(403).end();
                              next();
                          }
                        : controller.authorize || [],
                    controller
                )
            );
        }
    }
    return app;
};

module.exports.Router = express.Router;

for (let fn of require('methods').concat('use', 'all')) {
    let orig = express.Router[fn];
    express.Router[fn] = function(...args) {
        return orig.apply(
            this,
            args.map(f => {
                if (typeof f != 'function' || f.length > 3 || (f.handle && f.set)) return f;
                return (req, res, next) => (async () => f(req, res, next))().catch(next);
            })
        );
    };
}
