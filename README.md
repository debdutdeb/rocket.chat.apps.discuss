# rocket.chat.apps.discuss

Create discussions via slashcommand

# Stuff

-   `/discuss #apps-support Add Discuss to Open` will create a new discussion named `Add Discuss to Open` in `#apps-support` room.
-   `/discuss The Discuss App` will create a new discussion named `The Discuss App` in the room where the command is executed, if the room is either a public channel or private group.
-   `/discuss` in any thread will create a discussion ~with that thread as it's parent~, the thread message as title, and ~the thread followers as members~ & the thread message as the first message.
-   `/discussion I like this` in any thread will create a discussion ~with that thread as it's parent~, `I like this` as title, and ~the thread followers as members~ the thread message as the first message.
