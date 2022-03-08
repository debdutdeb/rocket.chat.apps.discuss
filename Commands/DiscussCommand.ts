import {
    IHttp,
    IModify,
    IModifyCreator,
    INotifier,
    IPersistence,
    IRead
} from '@rocket.chat/apps-engine/definition/accessors'
import {App} from '@rocket.chat/apps-engine/definition/App'
import {
    RocketChatAssociationModel,
    RocketChatAssociationRecord
} from '@rocket.chat/apps-engine/definition/metadata'
import {IRoom, RoomType} from '@rocket.chat/apps-engine/definition/rooms'
import {
    ISlashCommand,
    SlashCommandContext
} from '@rocket.chat/apps-engine/definition/slashcommands'
import {IUser} from '@rocket.chat/apps-engine/definition/users'
import {IDiscussionWithThreadId} from '../Models/IDiscussionWithThreadId'

export class DiscussCommand implements ISlashCommand {
    public command: string = 'discuss'
    public i18nDescription: string = 'Description'
    public i18nParamsExample: string = 'Params'
    public providesPreview: boolean = false

    private contextRoom: IRoom
    private commandSender: IUser
    private me: IUser
    private notifier: INotifier
    private modify: IModify
    private creator: IModifyCreator
    private read: IRead
    private persis: IPersistence
    private record: RocketChatAssociationRecord

    constructor(private readonly app: App) {
        this.app = app
    }

    public async executor(
        context: SlashCommandContext,
        read: IRead,
        modify: IModify,
        http: IHttp,
        persis: IPersistence
    ): Promise<void> {
        this.contextRoom = context.getRoom()
        this.commandSender = context.getSender()
        this.modify = modify
        this.notifier = modify.getNotifier()
        this.creator = modify.getCreator()
        this.persis = persis
        this.me = (await read.getUserReader().getAppUser()) as IUser
        this.read = read
        this.record = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            'thread-discussion-map'
        )

        const threadId = context.getThreadId()

        const argString = context.getArguments().join(' ')

        if (threadId) {
            return await this.startDiscussionFromThread(threadId, argString)
        }

        await this.startDiscussionFromCLI(argString)
    }

    private readonly isRoomDiscussion = (room: IRoom): boolean =>
        Boolean(room.parentRoom)

    private async notify(text: string, threadId?: string): Promise<void> {
        await this.notifier.notifyUser(this.commandSender, {
            emoji: ':cloud:',
            sender: this.me,
            room: this.contextRoom,
            attachments: [{color: 'red', text}],
            threadId
        })
    }

    private async startDiscussion(
        displayName: string,
        parentRoom: IRoom,
        users?: Array<IUser>,
        customFields?: {[K: string]: any}
    ): Promise<string | undefined> {
        // TODO: change this
        const slugify = (str?: string): string | undefined =>
            str?.toLowerCase().replace(/[^a-zA-Z0-9\_\-\.]/g, '')

        try {
            return await this.creator.finish(
                this.creator
                    .startDiscussion({
                        creator: this.commandSender,
                        displayName,
                        slugifiedName: slugify(displayName),
                        parentRoom,
                        type: RoomType.CHANNEL,
                        customFields
                    })
                    .setMembersToBeAddedByUsernames(
                        users?.map((user: IUser): string => user.username) || []
                    )
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

    private async getDiscussionUrl(discussion: IRoom): Promise<string> {
        const siteUrl = (await this.read
            .getEnvironmentReader()
            .getServerSettings()
            .getValueById('Site_Url')) as string
        return `${siteUrl.replace(/\/$/, '')}/channel/${discussion.id}`
    }

    private async startDiscussionFromThread(
        threadId: string,
        discussionName?: string
    ): Promise<void> {
        if (this.isRoomDiscussion(this.contextRoom)) {
            return await this.notify(
                // tslint:disable-next-line: quotemark
                "this room isn't public channel or private group, either pass a `#RoomName` or execute `/discuss` in a different room"
            )
        }

        const discussion = await this.findDiscussionByThread(threadId)
        if (discussion) {
            // gotcha mafrand
            // FIXME: can't do this unfortunately :(
            await this.modify
                .getUpdater()
                .finish(
                    (
                        await this.modify
                            .getUpdater()
                            .room(discussion.id, this.commandSender)
                    ).addMemberToBeAddedByUsername(this.commandSender.username)
                )

            // so i'll just notify about the new thingy
            return await this.notify(
                `A discussion already exists, please join [here](${await this.getDiscussionUrl(
                    discussion
                )}).`
            )
        }

        const threadMessage = await this.read
            .getMessageReader()
            .getById(threadId)

        if (!threadMessage?.text && !discussionName) {
            return await this.notify(
                'no thread message text found to use as discussion name, please provide one',
                threadId
            )
        }

        const discussionId = await this.startDiscussion(
            discussionName || (threadMessage?.text as string),
            this.contextRoom,
            threadMessage?.sender.id === this.commandSender.id
                ? []
                : [threadMessage?.sender as IUser],
            // expected this to work, but isn't, leaving it here so that I can be sad about it
            {pmid: threadId}
        )

        if (!discussionId) {
            return
        }

        // since {pmid: any} isn't working
        // the first message in a discussion created from a thread
        // will be by the thread creator, and the thread message
        // but a bit fancier

        await this.creator.finish(
            this.creator
                .startMessage()
                .setSender(threadMessage?.sender as IUser)
                .setRoom(
                    (await this.read
                        .getRoomReader()
                        .getById(discussionId)) as IRoom
                )
                .setAttachments(
                    threadMessage?.attachments || [
                        {color: 'green', text: threadMessage?.text as string}
                    ]
                )
        )

        const room = (await this.read
            .getRoomReader()
            .getById(discussionId)) as IRoom

        await this.persis.updateByAssociation(this.record, {...room, threadId})
    }

    private async doIBelong(room: IRoom): Promise<boolean> {
        const members = await this.read.getRoomReader().getMembers(room.id)
        return members.map(member => member.id).includes(this.commandSender.id)
    }

    private async startDiscussionFromCLI(argString: string): Promise<void> {
        // it'll never return null since all regex matches are optional
        const [, , roomName, discussionName]: Array<string> =
            /(^#([^\s]+)\s*)?(.+)?$/.exec(argString) as RegExpExecArray

        if (!discussionName) {
            return await this.notify('you must provide a discussion name')
        }

        const room = roomName
            ? await this.read.getRoomReader().getByName(roomName)
            : this.contextRoom
        if (!room) {
            return await this.notify(`room \`${roomName}\` not found`)
        }

        if (!(await this.doIBelong(room))) {
            return await this.notify(
                'You are not a member of said room: ' + room.displayName
            )
        }

        if (this.isRoomDiscussion(room)) {
            return await this.notify(
                `${
                    /* means this room is where command's been run */
                    room.id === this.contextRoom.id
                        ? 'this room'
                        : `\`${room.displayName ?? room.slugifiedName}\``
                } isn't a public channel or private group, either pass a different \`#RoomName\` or execute \`/discuss\` in another room `
            )
        }

        await this.startDiscussion(discussionName, room)
    }

    private async findDiscussionByThread(
        threadId: string
    ): Promise<IDiscussionWithThreadId | undefined> {
        // do stuff
        const data = await this.read
            .getPersistenceReader()
            .readByAssociation(this.record)

        return data.find(
            room => (room as IDiscussionWithThreadId).threadId === threadId
        ) as IDiscussionWithThreadId | undefined
    }
}
