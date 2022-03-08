import {IRoom} from '@rocket.chat/apps-engine/definition/rooms'

export interface IDiscussionWithThreadId extends IRoom {
    threadId: string
}
