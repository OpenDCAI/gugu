export interface MomentsMedia {
  id: string
  url: string
  mediaType: string
  sortOrder: number
  storageObjectName: string | null
}

export interface MomentsAuthor {
  id: string
  name: string
  avatar: string | null
  guguNumber: number | null
  bio: string | null
  isOfficial: boolean
}

export interface MomentsPost {
  id: string
  author: MomentsAuthor
  content: string | null
  createdAt: string
  media: MomentsMedia[]
  likeCount: number
  likedByMe: boolean
  commentCount: number
  isMine: boolean
}

export interface MomentsComment {
  id: string
  postId: string
  parentId: string | null
  author: MomentsAuthor
  content: string
  createdAt: string
  media: MomentsMedia[]
  isMine: boolean
  /** 扁平一层展示用：本条是回复时，被回复者的显示名；否则 null。 */
  replyToName: string | null
}
