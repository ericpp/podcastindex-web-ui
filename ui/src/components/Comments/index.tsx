import * as React from 'react'
import DOMPurify from 'dompurify'

import './styles.scss'

interface IProps {
    id: number,
}

interface IState {
    showComments: boolean,
    loadingComments: boolean,
    comments: StateComment[] 
}

interface StateComment {
    url: string,
    publishedAt?: Date,
    summary?: string,
    content?: string,
    attributedTo?: Commenter,
    replies?: StateComment[],
    commentError?: string,
    repliesError?: string,
    loaded: boolean
}

interface Commenter {
    name: string,
    iconUrl: string,
    url: string,
    account: string
}

interface ICommentProps {
    comment: StateComment 
}

class Comment extends React.PureComponent<ICommentProps> {
    constructor(props) {
        super(props);
    }

    render(): React.ReactNode {
        return (
        <details open>
            {!this.props.comment.commentError && this.props.comment.loaded &&
                <summary>
                    <a className='profile' href={this.props.comment.attributedTo.url}>
                        <img className='profile-img' src={this.props.comment.attributedTo.iconUrl || '/images/brand-icon.svg'} />
                        <div className='user'>
                            <strong>{this.props.comment.attributedTo.name}</strong>
                            <span className='handle'>{this.props.comment.attributedTo.account}</span>
                        </div>
                    </a>
                    <span aria-hidden="true">·</span>
                    <a href={this.props.comment.url} className='permalink'>
                        <time>{this.props.comment.publishedAt.toLocaleString()}</time>
                    </a>
                </summary>
            }
            {   this.props.comment.summary ? 
                <div className="contents">
                    <details className="content-warning">
                        <summary>Content Warning Summary</summary>
                        {
                            !this.props.comment.commentError && this.props.comment.content &&
                            <div dangerouslySetInnerHTML={{__html: this.props.comment.content}}/>
                        }
                    </details>
                </div>
                :
                // content can be empty when there are attachments
                !this.props.comment.commentError && this.props.comment.content &&
                <div className="contents" dangerouslySetInnerHTML={{__html: this.props.comment.content}}/>
            }
            {!this.props.comment.loaded && 
                <summary>
                    <a className='profile' href={this.props.comment.url}>
                        <img className='profile-img' src='/images/brand-icon.svg' />
                        <strong>Loading...</strong>
                    </a>
                </summary>
            }
            {this.props.comment.commentError && 
                <summary>
                    <a className='profile' href={this.props.comment.url}>
                        <img className='profile-img' src='/images/brand-icon.svg' />
                        <strong>Error loading this comment</strong>
                    </a>
                </summary>
            }
            {!this.props.comment.repliesError && this.props.comment.replies && <div>
                {this.props.comment.replies.map((reply) => <Comment key={reply.url} comment={reply}/>)}
            </div>}
            {
                this.props.comment.repliesError && <div className='contents'>Error loading replies for this comment</div>
            }
        </details>
        )
    }
}

export default class Comments extends React.PureComponent<IProps, IState> {
    constructor(props) {
        super(props);
        this.state = {
            showComments: false,
            loadingComments: false,
            comments: []
        };
    }
    
    async onClickShowComments() {
        const responseBody = {
            roots: [],
            nodes: {},
            commenters: {}
        };


        if(!this.state.comments.length) {
            this.setState({
                loadingComments: true
            });

            const nsJsonStream = new TransformStream({
                // https://web.dev/streams/#creating-a-transform-stream
                transform(chunk, controller) {
                    const decoded = new TextDecoder().decode(chunk);
                    this.buffer = (this.buffer || '') + decoded
                    let index = -1;

                    while ((index = this.buffer.indexOf("\n")) !== -1) {
                        const chk = this.buffer.substring(0, index)
                        controller.enqueue(JSON.parse(chk));
                        this.buffer = this.buffer.substring(index + 1)
                    }
                },
                flush(controller) {
                    if (this.buffer) {
                        controller.enqueue(JSON.parse(this.buffer));
                    }

                    controller.terminate();
                },
            });

            const response = await fetch('/api/comments/byepisodeid?' + new URLSearchParams({id: String(this.props.id) }));

            const reader = response.body.pipeThrough(nsJsonStream).getReader();

            const thisComponent = this;

            await reader.read().then(function processChunk({done, value}) {
                if(done) {
                    thisComponent.setState({
                        loadingComments: false
                    });
                    return;
                }

                updateResponseBody(responseBody, value);

                const stateToSet: any = {
                    showComments: true,
                };

                stateToSet.comments = responseBody.roots.map((root) => Comments.buildStateComment(root, responseBody));
                
                thisComponent.setState(stateToSet);
                return reader.read().then(processChunk);
            });

            function updateResponseBody(responseBody, parsedChunk) {
                responseBody.roots = responseBody.roots.concat(parsedChunk.roots);
                for(let key in parsedChunk.nodes) {
                    responseBody.nodes[key] = parsedChunk.nodes[key];
                }
                for(let key in parsedChunk.commenters) {
                    responseBody.commenters[key] = parsedChunk.commenters[key];
                }
            }
        }
        else {
            this.setState({
                showComments: true
            });
        }
    }

    async onClickHideComments() {
        this.setState({showComments: false});
    }

    private static buildStateComment(commentUrl: string, commentsApiResponseBody): StateComment | null {
        let stateComment: StateComment = {
            url: commentUrl,
            loaded: false
        }

        const node = commentsApiResponseBody.nodes[commentUrl];

        if(!node) {
            return stateComment;
        }

        stateComment.loaded = true;

        const commenter = node.comment && commentsApiResponseBody.commenters[node.comment.attributedTo];

        if(node.comment) {
            const summary = node.comment.summary && DOMPurify.sanitize(Comments.resolveLanguageTaggedValues(node.comment.summary));
            const content = node.comment.content && DOMPurify.sanitize(Comments.resolveLanguageTaggedValues(node.comment.content));

            stateComment = {
                ...stateComment,
                url: node.comment.url,
                publishedAt: new Date(node.comment.published),
                summary: summary,
                content: content,

                attributedTo: commenter && {
                    name: commenter.name,
                    iconUrl: commenter.icon?.url,
                    url: commenter.url,
                    account: commenter.fqUsername,
                }
            }
        }
        else {
            console.warn('There was an error on the server fetching a comment', node.commentError);
            stateComment.commentError = node.commentError;
        }

        if(node.replies) {
            stateComment = {
                ...stateComment,
                replies: node.replies.map((reply) => Comments.buildStateComment(reply, commentsApiResponseBody))
            }
        }
        else {
            console.warn('There was an error on the server fetching a replies to a comment', node.repliesError);
            stateComment.repliesError = node.repliesError
        }

        return stateComment;
    }

    /**
     * Returns a single value from a an object with multiple language tagged values
     * 
     * Currently, it returns the value of the fist property in languageTaggedValues.
     * In the future, it should return the value of the property that best matches
     * the user's language (navigator.language || navigator.userLanguage), as
     * reference, see https://www.rfc-editor.org/info/bcp47
     * 
     * @example
     * // value will be 'A mensagem'
     * let value = resolveLanguageTaggedValues({pt-BR: 'A mensagem', en: 'The message'})
     * 
     * @param languageTaggedValues 
     * @returns the value of the first property in languageTaggedValues
     */
    private static resolveLanguageTaggedValues(languageTaggedValues): string | null {
        if(!languageTaggedValues) {
            return null;
        }

        for(let propertyName in languageTaggedValues) {
            if(languageTaggedValues.hasOwnProperty(propertyName)) {
                return languageTaggedValues[propertyName];
            }
        }
    }
    
    render() {
        return (
        <div className='comments-container'>
            {!this.state.showComments && <button disabled={this.state.loadingComments} onClick={() => this.onClickShowComments()}>Show comments</button>}
            {this.state.showComments && <button onClick={() => this.onClickHideComments()}>Hide comments</button>}
            {this.state.loadingComments && <p>Loading comments...</p>}
            {this.state.showComments && this.state.comments.map((comment) => <Comment key={comment.url} comment={comment}/>)}
        </div>
        )
    }
}