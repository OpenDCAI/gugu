# Topic controls use backend authority

Group topics inherit management from their source group. A topic creator's participant row does not grant administration. Topics in a DM or AI conversation retain creator authority.

The shared group administration transport validates the capabilities returned by `group_info_as`. Settings, topic rename, threshold inputs and the topic delete menu project those capabilities. Member rosters use `list_member_ids`, so participant role badges follow the same source authority while listen mode stays local to the topic.

The existing member profile and removal controls also serve topic participants. Role changes and invitations remain on the source group. A human owner can change their own Agent's listen mode or canonical name and remove it from a topic without being an administrator. A participant can leave their own topic. Personal pin and mute controls remain available independently of management.

This change requires the related backend topic-authority release. The client backend pin must be updated to that release's merged commit before release or acceptance. A backend without the required capability fields fails explicitly rather than being treated as an empty permission result.
