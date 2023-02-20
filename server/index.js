const path = require('path')
const fs = require('fs');
const express = require('express')
const app = express() // create express app
const { makeThreadcap, InMemoryCache, updateThreadcap, makeRateLimitedFetcher } = require('threadcap');
const fetch = require('node-fetch');
const packageJson = require('../package.json');

// Gets the .env variables
require('dotenv').config()

const USER_AGENT = `Podcastindex.org-web/${packageJson.version}`;

// Utilizing the node repo from comster/podcast-index-api :)
// NOTE: This server will work as a reverse proxy.
const api = require('podcast-index-api')(
    process.env.API_KEY,
    process.env.API_SECRET
)

const apiAdd = require('podcast-index-api')(
    process.env.API_ADD_KEY,
    process.env.API_ADD_SECRET
)

app.use((req, res, next) => {

    const { rawHeaders, httpVersion, method, socket, url } = req;
    const { remoteAddress, remoteFamily } = socket;

    // console.log(
    //     JSON.stringify({
    //         timestamp: Date.now(),
    //         rawHeaders,
    //         httpVersion,
    //         method,
    //         remoteAddress,
    //         remoteFamily,
    //         url
    //     })
    // );

    let userAgent = req.header('user-agent')
    let cfLocation = req.header('CF-IPCountry')
    let cfSourceIP = req.header('CF-Connecting-IP')
    let cfBotScore = req.header('Cf-Bot-Score')

    var logString = "["+Date.now()+"] " + "["+remoteAddress+"] " + method +" ("+url+") - UA: ["+userAgent+"] - LOC: ["+cfLocation+"|"+cfSourceIP+"] - BOT: ["+cfBotScore+"]"

    console.log(logString)

    next();
});

// ------------------------------------------------
// ---------- Static files for namespace ----------
// ------------------------------------------------

app.use('/namespace/1.0', async (req, res) => {
    fs.readFile('./server/data/namespace1.0.html', 'utf8', (err, data) => {
        // You should always specify the content type header,
        // when you don't use 'res.json' for sending JSON.
        res.set('Content-Type', 'text/html');
        res.send(data)
    })
})

// ------------------------------------------------
// ------------ Reverse proxy for API -------------
// ------------------------------------------------

app.use('/api/search/byterm', async (req, res) => {
    let term = req.query.q
    const response = await api.searchByTerm(term)
    res.send(response)
})

app.use('/api/search/bytitle', async (req, res) => {
    let term = req.query.q
    const response = await api.custom('search/bytitle', {q: term})
    res.send(response)
})

app.use('/api/recent/episodes', async (req, res) => {
    let max = req.query.max
    const response = await api.recentEpisodes(max)
    res.send(response)
})

app.use('/api/podcasts/bytag', async (req, res) => {
    const response = await api.podcastsByTag()
    res.send(response)
})

app.use('/api/podcasts/byfeedid', async (req, res) => {
    let feedId = req.query.id
    const response = await api.podcastsByFeedId(feedId)
    res.send(response)
})

app.use('/api/podcasts/byfeedurl', async (req, res) => {
    let feedUrl = req.query.url
    const response = await api.podcastsByFeedUrl(feedUrl)
    res.send(response)
})


app.use('/api/episodes/byfeedid', async (req, res) => {
    let feedId = req.query.id
    let max = req.query.max
    const response = await api.episodesByFeedId(feedId, null, max)
    res.send(response)
})

app.use('/api/add/byfeedurl', async (req, res) => {
    let feedUrl = req.query.url
    const response = await apiAdd.addByFeedUrl(feedUrl)
    res.send(response)
})

// ------------------------------------------------
// ------------ API to get comments for episode ---
// ------------------------------------------------
app.use('/api/comments/byepisodeid', async (req, res) => {
    let episodeId = req.query.id;
    const response = await api.episodesById(episodeId, false);

    const socialInteract = response.episode.socialInteract && response.episode.socialInteract.filter((si) => si.protocol === 'activitypub');

    if(!socialInteract && socialInteract.lenght >= 0) {
        // Bad requests sounds appropriate, as the client is only expected to call this API
        // when it validated upfront that the episode has a property socialInteract with activitypub protocol
        res.status(400).send('The episode does not contain a socialInteract property')
    }

    // send a HEAD request to the social interact url
    // to see if it's a mastodon server
    let presponse = await fetch(socialInteract[0].uri, {
        method: 'HEAD',
    })

    // parse the si url into parts
    let url = new URL(socialInteract[0].uri)
    let ids;

    // if it's a mastodon server and a /@user/1231456 url, then use the mastodon api
    if (
        presponse.headers.get('Server').includes('Mastodon') &&
        (ids = url.pathname.match(/\/\@[^\/]+\/([0-9]+)/))
    ) {
        let id = ids[1];

        // pull in the root post
        let rresponse = await fetch(`${url.origin}/api/v1/statuses/${id}`)
        let root = await rresponse.json();

        // pull in replies to the root post
        let cxresponse = await fetch(`${url.origin}/api/v1/statuses/${id}/context`)
        let context = await cxresponse.json();

        // combine root and replies together
        let comments = context.descendants.concat([root]);

        // track comments that are in reply to other comments
        let replies = comments.reduce((result, comment) => {
            if (comment.in_reply_to_id) {
                result[comment.in_reply_to_id] = result[comment.in_reply_to_id] || []
                result[comment.in_reply_to_id].push(comment.uri);
            }
            return result
        }, {});

        // commenter information
        let commenters = comments.reduce((result, comment) => {
            result[comment.account.url] = {
                'asof': comment.account.created_at,
                'fqUsername': comment.account.acct,
                'icon': {
                    'mediaType': 'image/jpeg',
                    'url': comment.account.avatar,
                },
                'name': comment.account.display_name,
                'url': comment.account.url,
            }
            return result
        }, {})

        // comments
        let nodes = comments.reduce((result, comment) => {
            result[comment.uri] = {
                'comment': {
                    'attachments': comment.media_attachments,
                    'attributedTo': comment.account.url,
                    'content': {'en': comment.content},
                    'published': comment.created_at,
                    'url': comment.url,
                },
                'commentAsof': comment.created_at,
                'replies': replies[comment.id] || [],
                'repliesAsof': comment.created_at,
            }
            return result
        }, {})

        res.send({
            'commenters': commenters,
            'nodes': nodes,
            'protocol': 'activitypub',
            'roots': [root.uri],
        });
    }

//     const userAgent = USER_AGENT;
//     const cache = new InMemoryCache();
//     const fetcher = makeRateLimitedFetcher(fetch);

//     const threadcap = await makeThreadcap(socialInteract[0].uri, { userAgent, cache, fetcher });

//     await updateThreadcap(threadcap, { updateTime: new Date().toISOString(), userAgent, cache, fetcher });

//     res.send(threadcap)
})

// ------------------------------------------------
// ---------- Static files for API data -----------
// ------------------------------------------------

app.use('/api/stats', async (req, res) => {
    fs.readFile('./server/data/stats.json', 'utf8', (err, data) => {
        // You should always specify the content type header,
        // when you don't use 'res.json' for sending JSON.  
        res.set('Content-Type', 'application/json');
        res.send(data)
      })
})

app.use('/api/newfeedstats', async (req, res) => {
    fs.readFile('./server/data/newfeedstats.json', 'utf8', (err, data) => {
        // You should always specify the content type header,
        // when you don't use 'res.json' for sending JSON.
        res.set('Content-Type', 'application/json');
        res.send(data)
    })
})

app.use('/api/apps', async (req, res) => {
    fs.readFile('./server/data/apps.json', 'utf8', (err, data) => {
        // You should always specify the content type header,
        // when you don't use 'res.json' for sending JSON.  
        res.set('Content-Type', 'application/json');
        res.send(data)
      })
})

app.use('/api/images', express.static('./server/assets'))

// ------------------------------------------------
// ---------- Static content for client -----------
// ------------------------------------------------

app.use(express.static('./server/www'))
app.get('*', (req, res) => res.sendFile(path.resolve('server', 'www', 'index.html')))

// ------------------------------------------------


const PORT = process.env.PORT || 333;

// start express server on port 5001 (default)
app.listen(PORT, () => {
    console.log(`server started on port ${PORT}`)
})
