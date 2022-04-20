import {App, Editor, EditorPosition, MarkdownView, Plugin, PluginSettingTab, Setting} from "obsidian";
import { regexLastIndexOf } from "./utils";

export default class TextSnippets extends Plugin {
	settings: TextSnippetsSettings;
	useLegacyEditor: boolean;
	singleWhitespace: RegExp = new RegExp(/\s/, 'g');

	async onload() {
		console.log("Loading snippets plugin");
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.addCommand({
			id: "text-snippets",
			name: "Run snippet replacement",
			callback: () => this.SnippetOnTrigger(),
			hotkeys: [{
				modifiers: ["Mod"],
				key: "tab"
			}],
		});

		//suppressing error on undocumented api call
		// @ts-ignore
		this.useLegacyEditor = this.app.vault.getConfig('legacyEditor');

		this.app.workspace.onLayoutReady(() => {
			this.settings.isWYSIWYG = !this.useLegacyEditor;
			//This isn't right. I suspect the right thing is the.app.workspace.on('editor-change', (editor) => this.handleKeyDown(editor))
			//and handleKeyDown should begin by getting (the.app.lastEvent as KeyboardEvent) and aborting if it's not a keyboard event?
			this.registerDomEvent(document, 'keydown', (event) => this.handleKeyDown(event));
		});

		this.addSettingTab(new TextSnippetsSettingsTab(this.app, this));
		await this.saveSettings();
	}

	async onunload() {
		console.log("Unloading text snippets plugin");

		//I think the line below is wrong. That event was never registered.
		//if I make the change described in the onload comment, I would be able to do something like:
		//this.app.workspace.off('editor-change', this.handleKeyDown);

		this.app.workspace.off('keydown', this.handleKeyDown);
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}

	UpdateSnippetLookup(newlineSymbol: string) {
		const nlSymb = newlineSymbol.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
		const regex = new RegExp('(?<!' + nlSymb +')\\n');

		this.settings.snippetLookup = this.settings.snippets_file
			.split(regex)
			.reduce((obj, [snippetId, replacement]) => {
				return ({...obj, [snippetId]: replacement})
			}, {});
	}

	getPotentialSnippetId(editor: Editor) {
		if(editor.somethingSelected()) {
			return editor.getSelection();
		}

		const cursor = editor.getCursor();
		const leftOfCursor = editor.getLine(cursor.line).slice(0, cursor.ch).trimEnd();
		let lastWhitespace = regexLastIndexOf(leftOfCursor, this.singleWhitespace);
		if(lastWhitespace < 0) lastWhitespace = 0;

		return leftOfCursor.slice(lastWhitespace);
	}

	findSnippet(editor : Editor, cursorOrig: EditorPosition, cursor: EditorPosition) : string {
		let potentialSnippetId = this.getPotentialSnippetId(editor);

		//I'm not sure this is necessary anymore.
		// First of all, the new getPotentialSnippetId logic splits on spaces, so I think the WoSpaces var is unnecessary
		// also I don't quite understand the logic:
		// 	if the potentialSnippet is blank (ie there is nothing at all to the left of the cursor)
		//		then we should move left (why twice?) and try again. I guess because maybe it's trying to find the token
		//		on the line above? Is that what I want?
		// 	else if the token begins with one of the custom word delimiter special characters and cursorOrig is the same as cursor
		// 		cursorOrig is from editor.getCursor() while cursor is editor.getCursor('from')
		// 			what is the difference? When would these be different?
		//      then try moving left and getting a new snippet. Why would I want this?
		// Last, if I really do want to try to move backward until I find a token to try, shouldn't I "loop while" until
		//   I get something or until the beginning of the file? This seems like the natural way to do this logic,
		//   assuming I want this logic at all

		const psidWoSpaces = potentialSnippetId.split(' ').join('');
		if (psidWoSpaces === '' ||
			this.settings.wordDelimiterArray.indexOf(psidWoSpaces[0]) >= 0 && cursorOrig.ch == cursor.ch) {
			editor.exec('goWordLeft');
			editor.exec('goWordLeft');
			potentialSnippetId = this.getPotentialSnippetId(editor);
		}

		return this.settings.snippetLookup[potentialSnippetId] ?? "";
	}

	calculateCursorStopPos(nStr: string, cursor: EditorPosition): [string, {nlinesCount: number, position: number}] {

		const nlSymb = this.settings.newlineSymbol;
		const strReplacementWoNewlines = nStr.split('\n').join('');

		let endPosIndex = strReplacementWoNewlines.indexOf(this.settings.endSymbol);
		if (endPosIndex == -1) {
			endPosIndex = strReplacementWoNewlines.length;
		}

		let stopPosIndex = endPosIndex;
		if (strReplacementWoNewlines.indexOf(this.settings.stopSymbol) == -1) {
			const lastNl = strReplacementWoNewlines.substring(0, endPosIndex).lastIndexOf(nlSymb);
			if (lastNl !== -1) {
				stopPosIndex = endPosIndex - lastNl - nlSymb.length - cursor.ch;
			}
		}

		const nlSymbWoSpecial = nlSymb.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'); //no special symbols in nlSymb
		const regexPattern = `${nlSymbWoSpecial}\\n|${nlSymbWoSpecial}`;
		const regex = new RegExp(regexPattern);
		const regexGlobal = new RegExp(regexPattern, 'g');
		const nlinesCount = (strReplacementWoNewlines.substring(0, endPosIndex).match(regexGlobal) || []).length;

		const strReplacement = strReplacementWoNewlines
			.split(regex)
			.join('\n')
			.replace(this.settings.endSymbol,'');

		return [strReplacement, {nlinesCount: nlinesCount, position: stopPosIndex}]
	}

	insertSnippet(editor: Editor, key: string = ''): boolean {

		const cursorOrig = editor.getCursor();
		const cursorStart = editor.getCursor('from');
		const cursorEnd = editor.getCursor('to');

		const strSnippet = this.findSnippet(editor, cursorOrig, cursorStart);

		//proceed Tab and Spacebar
		//I think this is for the tab stop logic?
		if (strSnippet === "" ||
			(key === 'Space' && (cursorOrig.ch !== cursorEnd.ch || cursorOrig.line !== cursorEnd.line)) )  {
			if (!editor.somethingSelected()) {
				editor.getDoc().setSelection(cursorOrig, cursorOrig);
			}
			if (key === 'Space') return false;
			if (strSnippet === "") {
				editor.setCursor(cursorOrig);
				return this.nextStop(editor);
			}
		}

		const [strReplacement, endPosition] = this.calculateCursorStopPos(strSnippet, cursorStart);

		editor.replaceSelection(strReplacement);

		const stopFound = strReplacement.indexOf(this.settings.stopSymbol) !== -1;
		if (stopFound) {
			editor.setCursor({
				line: cursorStart.line,
				ch: cursorStart.ch
			});

			return this.nextStop(editor);
		} else {
			editor.setCursor({
				line: cursorStart.line + endPosition.nlinesCount,
				ch: cursorStart.ch + endPosition.position
			});
		}

		editor.focus();
		return true;
	}

	handleKeyDown (event: KeyboardEvent): void {
		if ((this.settings.useTab && event.key === 'Tab') || (this.settings.useSpace && event.code === 'Space')) {
			this.SnippetOnTrigger(event.code, true, event);
		}
	}

	SnippetOnTrigger(key: string = '', preventDefault: boolean = false, event?: KeyboardEvent): void {
		const editor = this.getEditor();
		if(editor === null) return;

		const cursorStart = editor.getCursor();

		if (!this.insertSnippet(editor, key)) return;

		this.settings.isWYSIWYG = !this.useLegacyEditor;

		if (preventDefault) {
			event.preventDefault();
			if (this.settings.isWYSIWYG && key == 'Tab'){
				// delete '\t' in Live preview
				const search = editor.searchCursor('\t', cursorStart);
				if (search.findPrevious()) {
					search.replace('');
				}
			}
		}

		if (cursorStart.ch > -1 && cursorStart.line > -1) {		//paste text from clipboard
			navigator.clipboard.readText().then(
				(clipText) => {
					const search = this.settings.isWYSIWYG
						? editor.searchCursor(this.settings.pasteSymbol, cursorStart)
						: editor.getSearchCursor(this.settings.pasteSymbol, cursorStart);

					if (search.findNext()) {
						search.replace(clipText);
					}
				}
			);
		}
	}

	nextStop(editor: Editor): boolean {

		const search = this.settings.isWYSIWYG
			? editor.searchCursor(this.settings.stopSymbol, editor.getCursor())
			: editor.getSearchCursor(this.settings.stopSymbol, editor.getCursor());

		if (search.findNext()) {
			search.replace("");

			const cursorTo =  this.settings.isWYSIWYG
				? search.current().from
				: search.from();

			editor.setCursor(cursorTo);

			return true;
		}

		return false;
	}

	getEditor(): Editor {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.editor;
	}

}

interface TextSnippetsSettings {
	snippets_file: string;
	snippetLookup: any;
	endSymbol: string;
	newlineSymbol: string;
	stopSymbol: string;
	pasteSymbol: string;
	useTab: boolean;
	useSpace: boolean;
	wordDelimiters: string;
	wordDelimiterArray: string[],
	isWYSIWYG: boolean;
}

const DEFAULT_SETTINGS: TextSnippetsSettings = {
	snippets_file: "snippets : It is an obsidian plugin, that replaces your selected text.",
	snippetLookup : { "snippets": "It is an obsidian plugin, that replaces your selected text."},
	endSymbol: '$end$',
	newlineSymbol: '$nl$',
	stopSymbol: "$tb$",
	pasteSymbol: "$pst$",
	useTab: true,
	useSpace: false,
	wordDelimiters: "$()[]{}<>,.!?;:\'\"\\/",
	wordDelimiterArray: Array.from("$()[]{}<>,.!?;:\'\"\\/"),
	isWYSIWYG: false,
}

class TextSnippetsSettingsTab extends PluginSettingTab {
	plugin: TextSnippets;

	constructor(app: App, plugin: TextSnippets) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;

		containerEl.empty();
		containerEl.createEl('h2', {text: 'Text Snippets - Settings'});

		new Setting(containerEl)
		.setName("Snippets")
		.setDesc("Type here your snippets in format 'snippet : result', one per line. Empty lines will be ignored. Ctrl+Tab to replace (hotkey can be changed).")
		.setClass("text-snippets-class")
		.addTextArea((text) =>
			text
			.setPlaceholder("before : after")
			.setValue(this.plugin.settings.snippets_file)
			.onChange(async (value) => {
				this.plugin.settings.snippets_file = value;
				this.plugin.UpdateSnippetLookup(this.plugin.settings.newlineSymbol);
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl)
		.setName("Cursor end position mark")
		.setDesc("Places the cursor to the mark position after inserting a snippet (default: $end$).\nMark does not appear anywhere within the snippet. Do not use together with Stop Symbol.")
		.setClass("text-snippets-cursor")
		.addTextArea((text) =>
			text
			.setPlaceholder("$end$")
			.setValue(this.plugin.settings.endSymbol)
			.onChange(async (value) => {
				if (value == '') {
					value = '$end$';
				}
				this.plugin.settings.endSymbol = value;
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl)
		.setName("Newline mark")
		.setDesc("Ignores newline after mark, replace it with a newline character after expanding (default: $nl$).\nNecessary to write before every line break in multiline snippets.")
		.setClass("text-snippets-newline")
		.addTextArea((text) =>
			text
			.setPlaceholder("$nl$")
			.setValue(this.plugin.settings.newlineSymbol)
			.onChange(async (value) => {
				if (value == '') {
					value = '$nl$';
				}
				this.plugin.settings.newlineSymbol = value;
				this.plugin.UpdateSnippetLookup(value);
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl)
		.setName('Stop Symbol')
		.setDesc('Symbol to jump to when command is called.')
		.setClass("text-snippets-tabstops")
		.addTextArea((text) => text
			.setPlaceholder('')
			.setValue(this.plugin.settings.stopSymbol)
			.onChange(async (value) => {
				if (value =='') {
					value = '$tb$';
				}
				this.plugin.settings.stopSymbol = value;
				await this.plugin.saveSettings();
			})
		);


		new Setting(containerEl)
		.setName('Clipboard paste Symbol')
		.setDesc('Symbol to be replaced with clipboard content.')
		.setClass("text-snippets-tabstops")
		.addTextArea((text) => text
			.setPlaceholder('')
			.setValue(this.plugin.settings.pasteSymbol)
			.onChange(async (value) => {
				if (value =='') {
					value = '$pst$';
				}
				this.plugin.settings.pasteSymbol = value;
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl)
		.setName("Expand on Tab")
		.setDesc("Use the Tab key as the trigger.")
		.addToggle(toggle =>
			toggle.setValue(this.plugin.settings.useTab)
			.onChange(async (value) => {
				this.plugin.settings.useTab = !this.plugin.settings.useTab;
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl)
		.setName("Expand on Space")
		.setDesc("Use the Space bar button as the trigger.")
		.addToggle(toggle =>
			toggle.setValue(this.plugin.settings.useSpace)
			.onChange(async (value) => {
				this.plugin.settings.useSpace = !this.plugin.settings.useSpace;
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl)
		.setName("Live Preview Mode")
		.setDesc("Toggle manually if not correct. You should restart plugin after changing this option.")
		.addToggle(toggle =>
			toggle.setValue(this.plugin.settings.isWYSIWYG)
			.onChange(async (value) => {
				this.plugin.settings.isWYSIWYG = !this.plugin.settings.isWYSIWYG;
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl)
		.setName('Word delimiters')
		.setDesc('Characters for specifying the boundary between separate words.')
		.setClass("text-snippets-delimiter")
		.addTextArea((text) => text
			.setPlaceholder('')
			.setValue(this.plugin.settings.wordDelimiters)
			.onChange(async (value) => {
				this.plugin.settings.wordDelimiters = value;
				this.plugin.settings.wordDelimiterArray = Array.from(value);
				await this.plugin.saveSettings();
			})
		);

	}
}
