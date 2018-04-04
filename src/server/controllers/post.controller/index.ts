import {getUpdatedPost, updatePost, validateNewPost} from './update';
import Moderator from '../../models/moderator.model';
import APIError from '../../helpers/APIError';
import {getContent} from '../../steemAPI';
import Post from '../../models/post.model';
import User from '../../models/user.model';
import * as HttpStatus from 'http-status';
import * as request from 'superagent';
import * as sc2 from '../../sc2';
import {top} from './top';
import {moderator} from './moderator';
import {aggregateGroup, aggregateMatch, aggregatePostList} from "./top/aggregate";

function postMapper(post) {
    post.pending = false;
    post.reviewed = false;
    post.flagged = false;

    if (post.json_metadata.moderator) {
        // Enable backwards compatibility for the front end
        const mod = post.json_metadata.moderator;
        post.moderator = mod.account || undefined;
        post.pending = mod.pending || false;
        post.reviewed = mod.reviewed || false;
        post.flagged = mod.flagged || false;
    }

    post.questions = post.json_metadata.questions || [];
    post.score = post.json_metadata.score || 0;

    return post;
}

function sendPost(res, post) {
    res.json(postMapper(post));
}

function get(req, res, next) {
    Post.get(req.params.author, req.params.permlink)
        .then(post => sendPost(res, post)).catch(e => next(e));
}

async function create(req, res, next) {
    const author = req.body.author;
    const permlink = req.body.permlink;
    try {
        try {
            const dbPost = await Post.get(author, permlink);
            return sendPost(res, dbPost);
        } catch (e) {
            if (!(e instanceof APIError && e.status === HttpStatus.NOT_FOUND)) {
                return next(e);
            }
        }

        const updatedPost = updatePost({
            json_metadata: {}
        }, await getContent(author, permlink));

        if (await validateNewPost(updatedPost)) {
            const post = new Post(updatedPost);
            return sendPost(res, await post.save());
        }

        return res.sendStatus(HttpStatus.BAD_REQUEST);
    } catch (e) {
        next(e);
    }
}

async function update(req, res, next) {

    const author = req.params.author;
    const permlink = req.params.permlink;
    const flagged = getBoolean(req.body.flagged);
    const reserved = getBoolean(req.body.reserved);
    const moderator = req.body.moderator || null;
    const pending = getBoolean(req.body.pending);
    const reviewed = getBoolean(req.body.reviewed);
    const contribType = req.body.type || null;
    const repo = req.body.repository || null;
    const tags = req.body.tags || null;
    const questions = req.body.questions || [];
    const score = req.body.score ? parseFloat(req.body.score) : 0;

    try {
        const post = await getUpdatedPost(author, permlink);
        if (moderator) {
            if (!post.json_metadata.moderator) {
                post.json_metadata.moderator = {};
            }
            if (!res.locals.moderator
                || (res.locals.moderator.account !== moderator)
                || (res.locals.moderator.account === author)) {
                res.status(HttpStatus.UNAUTHORIZED);
                return res.json({"message": "Unauthorized"});
            }

            if (contribType) post.json_metadata.type = contribType;
            if (repo) post.json_metadata.repository = repo;
            if (tags) post.json_metadata.tags = tags;
            if (moderator) post.json_metadata.moderator.account = moderator;
            if (questions) post.json_metadata.questions = questions;
            if (score) post.json_metadata.score = score;

            if (reviewed) {
                post.json_metadata.moderator.time = new Date().toISOString();
                post.json_metadata.moderator.reviewed = true;
                post.json_metadata.moderator.pending = false;
                post.json_metadata.moderator.flagged = false;

                if (post.json_metadata.type === 'bug-hunting' && !post.json_metadata.issue) {
                    try {
                        const user = await User.get(post.author);
                        if (user.github && user.github.account) {
                            const resGithub = await request.post(`https://api.github.com/repos/${post.json_metadata.repository.full_name.toLowerCase()}/issues`)
                                .set('Content-Type', 'application/json')
                                .set('Accept', 'application/json')
                                .set('Authorization', `token ${user.github.token}`)
                                .send({
                                    title: post.title,
                                    body: post.body,
                                });
                            const issue = resGithub.body;
                            const {html_url, number, id, title} = issue;

                            post.json_metadata.issue = {
                                url: html_url,
                                number,
                                id,
                                title,
                            };
                        }
                    } catch (e) {
                        console.log("ERROR REVIEWING GITHUB", e);
                    }
                }
            } else if (flagged) {
                post.json_metadata.moderator.time = new Date().toISOString();
                post.json_metadata.moderator.flagged = true;
                post.json_metadata.moderator.reviewed = false;
                post.json_metadata.moderator.pending = false;
            } else if (pending) {
                post.json_metadata.moderator.time = new Date().toISOString();
                post.json_metadata.moderator.pending = true;
                post.json_metadata.moderator.reviewed = false;
                post.json_metadata.moderator.flagged = false;
            } else if (reserved) {
                post.json_metadata.moderator.time = new Date().toISOString();
                post.json_metadata.moderator.pending = false;
                post.json_metadata.moderator.reviewed = false;
                post.json_metadata.moderator.flagged = false;
            }

            try {
                const user = await User.get(post.author);
                await sc2.send('/broadcast', {
                    user,
                    data: {
                        operations: [[
                            'comment',
                            {
                                parent_author: post.parent_author,
                                parent_permlink: post.parent_permlink,
                                author: post.author,
                                permlink: post.permlink,
                                title: post.title,
                                body: post.body,
                                json_metadata: JSON.stringify(post.json_metadata),
                            }
                        ]]
                    }
                });
            } catch (e) {
                console.log('FAILED TO UPDATE POST DURING REVIEW', e);
            }
        }

        try {
            // don't modify json_metadata.moderator when operation is inline edit of category, repo, or tags
            if (questions) post.markModified('json_metadata.questions');
            if (score) post.markModified('json_metadata.score');
            if (contribType) post.markModified('json_metadata.type');
            if (repo) post.markModified('json_metadata.repository');
            if (tags) post.markModified('json_metadata.tags');
            if (moderator) post.markModified('json_metadata.moderator');

            const savedPost = await post.save();
            sendPost(res, savedPost);
        } catch (e) {
            console.log("ERROR REVIEWING POST", e);
            next(e);
        }

    } catch (e) {
        next(e);
    }
}

async function edit(req, res, next) {
    const params = {
        parent_author: '',
        parent_permlink: '',
        author: req.body.author,
        permlink: req.body.permlink,
        title: req.body.title,
        body: req.body.body,
        json_metadata: req.body.json_metadata
    };

    if (typeof(params.json_metadata) === 'string') {
        throw new APIError('Expected object for json_metadata', HttpStatus.BAD_REQUEST, true);
    }

    try {
        // Only grant cross edit permissions to mods
        if (res.locals.user.account !== params.author) {
            const mod = await Moderator.get(res.locals.user.account);
            if (!(mod && mod.isReviewed())) {
                throw new APIError('Only moderators can cross edit', HttpStatus.FORBIDDEN, true);
            }
        }

        // Validate post
        let post = await Post.get(params.author, params.permlink);
        const updatedPost: any = await getContent(params.author, params.permlink);
        if (!(updatedPost && updatedPost.author && updatedPost.permlink)) {
            throw new Error('Cannot create posts from edit endpoint');
        }

        post = updatePost(post, updatedPost);
        post.title = params.title;
        post.body = params.body;
        post.json_metadata = params.json_metadata;
        if (!(await validateNewPost(post, true, false))) {
            throw new APIError('Failed to validate post', HttpStatus.BAD_REQUEST, true);
        }

        // Broadcast the updated post
        const user = await User.get(params.author);
        await sc2.send('/broadcast', {
            user,
            data: {
                operations: [['comment', {
                    ...params,
                    parent_permlink: post.parent_permlink,
                    json_metadata: JSON.stringify(params.json_metadata)
                }]]
            }
        });

        // Update the post in the DB
        post.markModified('json_metadata.repository');
        await post.save();
    } catch (e) {
        next(e);
    }
}

function getPostById(req, res, next) {
    const {postId} = req.params;
    console.log(postId);

    if (postId === parseInt(postId, 10) || !isNaN(postId)) {
        const query = {
            'id': postId,
        };

        Post.list({limit: 1, skip: 0, query}).then(post => {
            res.json({
                url: post[0].url,
            });
        }).catch(e => next(e));
    }
}

async function list(req, res, next) {
    /*
     section : author | project | all
     type: ideas | code | graphics | social | all
     sortBy: created | votes | reward
     filterBy: active | review | any,
     status: pending | flagged | any
     */
    let {limit=20, skip=0, from, to, sort = "desc", project = null, type = 'all', filterBy = 'any', status = 'any', author = null, moderator = null, bySimilarity = null} = req.query;
    const cashoutTime = '1969-12-31T23:59:59';

    if (!from) {
        from = (new Date());
    } else {
        from = new Date(from);
    }
    if (!to) {
        let d = new Date();
        d.setDate(d.getDate() - 7);
        to = d;
    } else {
        to = new Date(to);
    }

    let select: any = {}

    let query: any = {};

    if (moderator !== null) {
        query = {
            ...query,
            'json_metadata.moderator.account': moderator,
        }
    }

    if (bySimilarity) {
        select = {
            "score": {
                "$meta": "textScore"
            }
        }
        sort = {
            "score": {
                "$meta": "textScore"
            }
        }
        query = {
            ...query,
            $text: {
                $search: bySimilarity
            }
        },
            {
                score: {
                    $meta: "textScore"
                }
            }
    }

    if (filterBy === 'review' && moderator !== null) {
        query = {
            ...query,
            'json_metadata.moderator.reviewed': {$ne: true},
            'json_metadata.moderator.account': {
                $ne: moderator,
            }
        }
    }

    if (status === 'pending') {
        query = {
            ...query,
            'json_metadata.moderator.pending': true,
        }
    }

    if (status === 'flagged') {
        query = {
            ...query,
            'json_metadata.moderator.flagged': true,
        }
    }

    if (status === 'reviewed') {
        query = {
            ...query,
            'json_metadata.moderator.reviewed': true,
        }
    }

    if (filterBy === 'active') {
        query = {
            ...query,
            cashout_time:
                {
                    $gt: cashoutTime
                },
        };
    }

    if (filterBy === 'inactive') {
        query = {
            ...query,
            cashout_time:
                {
                    $eq: cashoutTime
                },
        };
    }

    if (type !== 'all') {
        if (type !== 'tasks') {
            query = {
                ...query,
                'json_metadata.type': type,
            };
        } else {
            query = {
                ...query,
                'json_metadata.type': {
                    $regex: (/task-/i)
                }
            };
        }
    }

    if (author !== null) {
        query = {
            ...query,
            author
        };
    }

    if (project !== null) {
        console.log(project);
        query = {
            ...query,
            'json_metadata.repository.id': {$eq:parseInt(project)}
        };
    }

    let aggregateQuery: any[] = [
        {
            $match: {
                'created': {
                    $lt: to.toISOString(),
                    $gte: from.toISOString()
                }
            }
        }
    ];

    if (Object.keys(query).length > 0 && query.constructor === Object) {
        aggregateQuery.push({$match:query});
    }

    let data = await Post.aggregate(aggregateQuery);
    data.sort((a: any, b: any) => b["json_metadata"]["score"] - a["json_metadata"]["score"]);

    if (sort !== "desc") {
        data = data.reverse();
    }

    let result = {
        total: data.length,
        data: data
    };

    result.data = result.data.slice(skip, skip + limit);

    res.json(result);


    // Post.countAll({query})
    //     .then(count => {
    //         Post.list({limit, skip, query, sort, select})
    //             .then((posts: any[]) => res.json({
    //                 total: count,
    //                 results: posts.map(postMapper)
    //             }))
    //             .catch(e => next(e));
    //
    //     })
    //     .catch(e => next(e));
}

function getBoolean(val?: string | boolean): boolean {
    return val === true || val === 'true';
}

export default {
    getPostById,
    get,
    edit,
    create,
    update,
    list,
    top,
    moderator
};
