import {
    IHttp,
    IModify,
    IModifyCreator,
    INotifier,
    IPersistence,
    IRead
} from '@rocket.chat/apps-engine/definition/accessors'
import {App} from '@rocket.chat/apps-engine/definition/App'
import {IRoom, RoomType} from '@rocket.chat/apps-engine/definition/rooms'
import {
    ISlashCommand,
    SlashCommandContext
} from '@rocket.chat/apps-engine/definition/slashcommands'
import {IUser} from '@rocket.chat/apps-engine/definition/users'

export class DiscussCommand implements ISlashCommand {
    public command: string = 'discuss'
    public i18nDescription: string = 'Description'
    public i18nParamsExample: string = 'Params'
    public providesPreview: boolean = false

    private contextRoom: IRoom
    private commandSender: IUser
    private me: IUser
    private notifier: INotifier
    private creator: IModifyCreator
    private read: IRead

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
        this.notifier = modify.getNotifier()
        this.creator = modify.getCreator()
        this.me = (await read.getUserReader().getAppUser()) as IUser
        this.read = read

        const threadId = context.getThreadId()

        const argString = context.getArguments().join(' ')

        if (threadId) {
            return await this.startDiscussionFromThread(threadId, argString)
        }

        await this.startDiscussionFromCLI(argString)
    }

    private readonly roomDiscussionOrDirect = (room: IRoom): boolean =>
        room.type === 'd' || !!room.parentRoom

    private async notify(text: string, threadId?: string): Promise<void> {
        await this.notifier.notifyUser(this.commandSender, {
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
    ): Promise<string> {
        const slugify = (str?: string): string | undefined =>
            str?.toLowerCase().replace(/[^a-zA-Z0-9\_\-\.]/g, '')

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
    }

    private async startDiscussionFromThread(
        threadId: string,
        discussionName?: string
    ): Promise<void> {
        if (this.roomDiscussionOrDirect(this.contextRoom)) {
            return await this.notify(
                // tslint:disable-next-line: quotemark
                "this room isn't public channel or private group, either pass a `#RoomName` or execute `/discuss` in a different room"
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

        if (this.roomDiscussionOrDirect(room)) {
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
}
