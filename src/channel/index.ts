/**
 * The Claude Code channel bridge (design §5).
 *
 * Other modules import from `$channel`, never from a file inside it.
 */
export {
	BACKOFF_MS,
	CAPABILITIES,
	CHANNEL_NAME,
	INSTRUCTIONS,
	createChannelServer,
	describeAnswer,
	describeAttachments,
	describeReaction,
	describeRise,
	main,
	newClientId,
	readFrames,
	runBridge
} from './bridge';
export type {
	AnswerFrame,
	BridgeOptions,
	ChannelAttachment,
	ChannelMessage,
	MessageFrame,
	ReactionFrame,
	Work,
	WorkFrame
} from './bridge';
export {
	CONNECTION_FILE,
	LINE_MAX,
	oneLine,
	readConnection,
	runMonitor,
	type Connection,
	type MonitorOptions
} from './monitor';
