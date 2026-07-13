// Hub view contract. Each tab is a body-only renderer + input handler; the hub
// shell draws the frame, status header, tab bar, and footer around it.

export interface HubView {
	id: string;
	/** Tab label shown in the bar. */
	label: string;
	/** Render exactly `height` body lines, each `width` cells wide. */
	render(width: number, height: number): string[];
	/** Return true if the key was consumed (hub then re-renders + stops). */
	handleInput(data: string): boolean | Promise<boolean>;
	/** Contextual footer hint for this view. */
	footerHint(): string;
	/** Called when the tab becomes active (e.g. to kick a lazy fetch). */
	onActivate?(): void;
}
