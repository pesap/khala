def preview:
  (. // "") | gsub("[\r\n]+"; " ") | .[0:300];

def suggestion_blocks:
  (. // "")
  | split("```suggestion")
  | .[1:]
  | map(
      split("```")[0]
      | sub("^\r?\n"; "")
      | sub("\r?\n$"; "")
      | {kind: "suggestion", replacement: .}
    );

def author_model($login): {login: ($login // "")};

def review_comment_model($restById):
  . as $comment
  | ($restById[($comment.databaseId | tostring)] // {}) as $rest
  | (($comment.body // $rest.body // "")) as $body
  | {
      id: ($comment.databaseId | tostring),
      commentId: $comment.databaseId,
      inReplyToId: ($rest.in_reply_to_id // $comment.replyTo.databaseId // null),
      author: author_model($comment.author.login),
      createdAt: ($comment.createdAt // $rest.created_at // ""),
      updatedAt: ($comment.updatedAt // $rest.updated_at // $comment.createdAt // ""),
      lastEditedAt: ($comment.lastEditedAt // null),
      url: ($comment.url // $rest.html_url // ""),
      path: ($comment.path // $rest.path // null),
      line: ($rest.line // $rest.original_line // null),
      startLine: ($rest.start_line // null),
      diffHunk: ($rest.diff_hunk // null),
      body: $body,
      bodyPreview: ($body | preview),
      suggestions: ($body | suggestion_blocks)
    };

($issueComments[0] // []) as $issueList
| ($reviewComments[0] // []) as $reviewCommentList
| ($reviewThreads[0].data.repository.pullRequest.reviewThreads.nodes // []) as $threadList
| ($reviews[0] // []) as $reviewList
| ($reviewCommentList | map({key: (.id | tostring), value: .}) | from_entries) as $restById
| (
    [
      $issueList[]?
      | select(.user.login == $author)
      | (.body // "") as $body
      | (.updated_at // .created_at // "") as $lastModified
      | {
          schemaVersion: 1,
          type: "issue-comment",
          id: (.id | tostring),
          commentId: .id,
          threadId: null,
          rootCommentId: null,
          inReplyToId: null,
          author: author_model(.user.login),
          createdAt: (.created_at // ""),
          updatedAt: (.updated_at // .created_at // ""),
          lastModified: $lastModified,
          url: (.html_url // ""),
          path: null,
          body: $body,
          bodyPreview: ($body | preview),
          suggestions: ($body | suggestion_blocks),
          replies: [],
          actorReplyCommentIds: [],
          actionable: true,
          skipReason: null,
          dedupeKey: "issue-comment:\(.id):\($lastModified)"
        }
    ]
    +
    [
      $reviewList[]?
      | select(.user.login == $author)
      | select((.body // "") != "")
      | (.body // "") as $body
      | (.submitted_at // .updated_at // "") as $lastModified
      | {
          schemaVersion: 1,
          type: "review",
          id: (.id | tostring),
          commentId: .id,
          threadId: null,
          rootCommentId: null,
          inReplyToId: null,
          author: author_model(.user.login),
          createdAt: (.submitted_at // ""),
          updatedAt: (.submitted_at // ""),
          lastModified: $lastModified,
          url: (.html_url // .pull_request_url // ""),
          path: null,
          body: $body,
          bodyPreview: ($body | preview),
          suggestions: ($body | suggestion_blocks),
          replies: [],
          actorReplyCommentIds: [],
          actionable: true,
          skipReason: null,
          dedupeKey: "review:\(.id):\($lastModified)"
        }
    ]
    +
    [
      $threadList[]?
      | . as $thread
      | (($thread.comments.nodes // []) | map(review_comment_model($restById))) as $comments
      | select(($comments | length) > 0)
      | (($comments | map(select(.inReplyToId == null)) | .[0]) // $comments[0]) as $root
      | ($comments | map(select(.inReplyToId == $root.commentId))) as $replies
      | ($replies | map(select(.author.login == $author))) as $actorReplies
      | (($comments | map(.updatedAt // .createdAt // "") | max) // $root.updatedAt // $root.createdAt // "") as $lastModified
      | {
          schemaVersion: 1,
          type: "review-thread",
          id: $thread.id,
          threadId: $thread.id,
          isResolved: ($thread.isResolved // false),
          rootCommentId: $root.commentId,
          commentId: $root.commentId,
          inReplyToId: null,
          author: $root.author,
          createdAt: $root.createdAt,
          updatedAt: $root.updatedAt,
          lastModified: $lastModified,
          url: $root.url,
          path: $root.path,
          line: $root.line,
          startLine: $root.startLine,
          diffHunk: $root.diffHunk,
          body: $root.body,
          bodyPreview: $root.bodyPreview,
          suggestions: $root.suggestions,
          replies: $replies,
          actorReplyCommentIds: ($actorReplies | map(.commentId)),
          actionable: (((($thread.isResolved // false) | not) and ($root.author.login == $author) and (($actorReplies | length) == 0))),
          skipReason: (
            if ($thread.isResolved // false) then "resolved-review-thread"
            elif $root.author.login != $author then "root-authored-by-other-user"
            elif ($actorReplies | length) > 0 then "actor-reply-present"
            else null
            end
          ),
          dedupeKey: "review-thread:\($thread.id):\($root.commentId):\($lastModified)"
        }
    ]
  )
| sort_by(.lastModified, .type, .id)
| .[]
