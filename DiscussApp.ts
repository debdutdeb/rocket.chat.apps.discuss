import {
    IAppAccessors,
    IConfigurationExtend,
    IConfigurationModify,
    IEnvironmentRead,
    ILogger
} from '@rocket.chat/apps-engine/definition/accessors'
import {App} from '@rocket.chat/apps-engine/definition/App'
import {IAppInfo} from '@rocket.chat/apps-engine/definition/metadata'
import {IUser} from '@rocket.chat/apps-engine/definition/users'
import {DiscussCommand} from './Commands/DiscussCommand'

export class DiscussApp extends App {
    public me: IUser

    constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
        super(info, logger, accessors)
    }

    public async onEnable(
        environment: IEnvironmentRead,
        configurationModify: IConfigurationModify
    ): Promise<boolean> {
        this.me = (await this.getAccessors()
            .reader.getUserReader()
            .getAppUser(this.getID())) as IUser
        if (!this.me) {
            this.getLogger().error("couldn't get app user")
            return false
        }
        return true
    }

    protected async extendConfiguration(
        configuration: IConfigurationExtend,
        environmentRead: IEnvironmentRead
    ): Promise<void> {
        await configuration.slashCommands.provideSlashCommand(
            new DiscussCommand(this)
        )
    }
}
