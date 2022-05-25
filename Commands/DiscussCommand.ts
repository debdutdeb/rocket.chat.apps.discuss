import {IHttp, IModify, IModifyCreator, INotifier, IPersistence, IRead} from '@rocket.chat/apps-engine/definition/accessors'
import {IMessage, IMessageAttachment} from '@rocket.chat/apps-engine/definition/messages'
import {RocketChatAssociationModel, RocketChatAssociationRecord} from '@rocket.chat/apps-engine/definition/metadata'
import {IRoom, RoomType} from '@rocket.chat/apps-engine/definition/rooms'
import {ISlashCommand, SlashCommandContext} from '@rocket.chat/apps-engine/definition/slashcommands'
import {IUser} from '@rocket.chat/apps-engine/definition/users'
import {DiscussApp} from '../DiscussApp'

const RoomTypeString: Record<Exclude<RoomType, RoomType.LIVE_CHAT>, 'channel' | 'direct' | 'group'> = {
    [RoomType.CHANNEL]: 'channel',
    [RoomType.DIRECT_MESSAGE]: 'direct',
    [RoomType.PRIVATE_GROUP]: 'group'
}

export class DiscussCommand implements ISlashCommand {
    public command: string = 'discuss'
    public i18nDescription: string = 'Description'
    public i18nParamsExample: string = 'Params'
    public providesPreview: boolean = false

    private contextRoom: IRoom
    private commandSender: IUser
    private notifier: INotifier
    private modify: IModify
    private creator: IModifyCreator
    private read: IRead
    private persis: IPersistence
    private record: RocketChatAssociationRecord

    constructor(private readonly app: DiscussApp) {
        this.app = app
    }

    public async executor(context: SlashCommandContext, read: IRead, modify: IModify, http: IHttp, persis: IPersistence): Promise<void> {
        this.contextRoom = context.getRoom()
        this.commandSender = context.getSender()
        this.modify = this.modify || modify
        this.notifier = this.notifier || modify.getNotifier()
        this.creator = this.creator || modify.getCreator()
        this.persis = this.persis || persis
        this.read = this.read || read
        this.record = this.record || new RocketChatAssociationRecord(RocketChatAssociationModel.ROOM, 'thread-discussion-map')

        const threadId = context.getThreadId()

        const argString = context.getArguments().join(' ')

        if (threadId) {
            const discussion = await this.findDiscussionByThreadId(threadId)
            if (discussion) {
                return this.joinDiscussion(discussion, threadId)
            }
            return this.startDiscussionFromThread(threadId, argString)
        }

        await this.startDiscussionFromCLI(argString)
    }

    private readonly isRoomDiscussion = (room: IRoom): boolean => Boolean(room.parentRoom)

    private async notify(text: IMessageAttachment['text'], threadId?: IMessage['threadId']): Promise<void> {
        await this.notifier.notifyUser(this.commandSender, {
            sender: this.app.me,
            room: this.contextRoom,
            attachments: [{color: 'red', text}],
            threadId
        })
    }

    private async joinDiscussion(discussion: IRoom, threadId: IMessage['threadId']): Promise<void> {
        const updater = this.modify.getUpdater()

        const updatedRoom = (await updater.room(discussion.id, this.commandSender)).addMemberToBeAddedByUsername(this.commandSender.username)
        await updater.finish(updatedRoom)

        const siteUrl = await this.read.getEnvironmentReader().getServerSettings().getValueById('Site_Url')
        let discussionUrlOrSlug = discussion.slugifiedName
        if (siteUrl) {
            discussionUrlOrSlug = `${siteUrl.replace(/\/$/, '')}/${RoomTypeString[discussion.type]}/${discussion.id}`
        }

        await this.notify(`A discussion already exists, please join [here](${discussionUrlOrSlug}).`, threadId)
    }
    private async startDiscussion(displayName: IRoom['displayName'], parentRoom: IRoom, users?: Array<IUser>, customFields?: {[K: string]: any}): Promise<string | undefined> {
        const slugify = (str?: string): string | undefined =>
            str
                ?.toLowerCase()
                .replace(' ', '-')
                .replace(/[^a-zA-Z0-9\_\-\.]/g, '')

        try {
            return this.creator.finish(
                this.creator
                    .startDiscussion({
                        creator: this.commandSender,
                        displayName,
                        slugifiedName: slugify(displayName),
                        parentRoom,
                        type: RoomType.CHANNEL,
                        customFields
                    })
                    .setMembersToBeAddedByUsernames(users?.map((user: IUser): string => user.username) || [])
            )
        } catch (e) {
            if (e.error === 'error-action-not-allowed') {
                await this.notify(e.reason)
                return
            }
            this.app.getLogger().error(e)
        }
        return
    }

    private async startDiscussionFromThread(threadId: NonNullable<IMessage['threadId']>, discussionName?: IRoom['displayName']): Promise<void> {
        if (this.isRoomDiscussion(this.contextRoom)) {
            return this.notify("this room isn't public channel or private group, either pass a `#RoomName` or execute `/discuss` in a different room")
        }

        const threadMessage = await this.read.getMessageReader().getById(threadId)

        if (!threadMessage?.text && !discussionName) {
            return await this.notify('no thread message text found to use as discussion name, please provide one', threadId)
        }

        const discussionId = await this.startDiscussion(
            discussionName || (threadMessage?.text as string),
            this.contextRoom,
            threadMessage?.sender.id === this.commandSender.id ? [] : [threadMessage?.sender as IUser],
            // expected this to work, but isn't, leaving it here so that I can be sad about it
            {pmid: threadId}
        )

        if (!discussionId) {
            return
        }

        const room = (await this.read.getRoomReader().getById(discussionId)) as IRoom

        /* since {pmid: any} isn't working
         * the first message in a discussion created from a thread
         * will be by the thread creator, and the thread message
         * but a bit fancier */

        await this.copyQuote(threadMessage as IMessage, room)

        // so basically
        // we discuss is going to add all messages as quotes to this
        // discussion

        // the RoomRead.getMessages isn't implemented :(
        /* await this.copyQuotes(threadMessage as IMessage, room) */

        await this.persis.updateByAssociation(this.record, {...room, pmid: threadId}, true)
    }

    private async copyQuote(threadMessage: IMessage, room: IRoom): Promise<void> {
        const siteUrl = (await this.read.getEnvironmentReader().getServerSettings().getValueById('Site_Url')).replace(/\/$/, '')
        const messageRoomType = RoomTypeString[threadMessage.room.type]

        const messagePermalink = (id: NonNullable<IMessage['id']>): string => `Main thread: ${siteUrl}/${messageRoomType}/${threadMessage.room.slugifiedName}?msg=${id}`

        /* RoomRead.getMessages isn't implemented yet :( sad! */
        /* const quotes: Array<string> = new Array()
         * for (const msg of await this.read
         *     .getRoomReader()
         *     .getMessages(threadMessage.room.id)) {
         *     if (msg.threadId !== threadMessage.id) break
         *     quotes.push(messagePermalink(msg.id as string))
         * } */

        await this.creator.finish(
            this.creator
                .startMessage()
                .setSender(threadMessage.sender)
                .setText(messagePermalink(threadMessage.id as string))
                .setRoom(room)
        )
    }

    private async isSenderMember(room: IRoom): Promise<boolean> {
        const members = await this.read.getRoomReader().getMembers(room.id)
        return members.map(member => member.id).includes(this.commandSender.id)
    }

    private async startDiscussionFromCLI(argString: string): Promise<void> {
        // it'll never return null since all regex matches are optional
        const [, , roomName, discussionName]: Array<string> = /(^#([^\s]+)\s*)?(.+)?$/.exec(argString) as RegExpExecArray

        if (!discussionName) {
            return await this.notify('you must provide a discussion name')
        }

        const room = roomName ? await this.read.getRoomReader().getByName(roomName) : this.contextRoom
        if (!room) {
            return this.notify(`room \`${roomName}\` not found`)
        }

        if (!(await this.isSenderMember(room))) {
            return this.notify('You are not a member of said room: ' + room.displayName)
        }

        if (this.isRoomDiscussion(room)) {
            return this.notify(
                '`' +
                    (room.displayName || room.slugifiedName) +
                    '`' +
                    ' is not a public channel or private group, either pass a different `#RoomName` or execute `/discuss` in another room'
            )
        }

        await this.startDiscussion(discussionName, room)
    }

    private async findDiscussionByThreadId(threadId: NonNullable<IMessage['threadId']>): Promise<IRoom | undefined> {
        const data = await this.read.getPersistenceReader().readByAssociation(this.record)

        /**
         * pmid is actually a property of the room::discussion model
         * just not yet available in apps-engine
         * so doing it this way
         */
        return data.find(room => (room as IRoom & {pmid: IMessage['id']}).pmid === threadId) as IRoom | undefined
    }
}

