import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	MarkdownView,
	Editor
} from "obsidian";

export default class TextSnippets extends Plugin {
	settings: TextSnippetsSettings;

	onInit() {}

	async onload() {
		console.log("Loading snippets plugin");
		await this.loadSettings();
		this.addCommand({
			id: "text-snippets",
			name: "Run snippet replacement",
			callback: () => this.SnippetOnTrigger(),
			hotkeys: [{
				modifiers: ["Mod"],
				key: "tab"
			}],
		});

		this.registerCodeMirror((editor) => {
			// the callback has to be called through another function in order for 'this' to work
			editor.on('keydown', (ed, event) => this.handleKeyDown(ed, event));
			this.settings.isWYSIWYG = (typeof editor.wordAt === 'function');
			
			if(this.settings.isWYSIWYG) {
				this.registerDomEvent(document, 'keydown', (event) => this.handleKeyDown(editor, event));
			}
		});

        if (this.settings.isWYSIWYG) {
            this.app.workspace.onLayoutReady(() => {
				const editor = this.getEditor();

                this.settings.isWYSIWYG = (typeof editor.wordAt === 'function');
                this.registerDomEvent(document, 'keydown', (event) => this.handleKeyDown(editor, event));
            }
        )}

		this.addSettingTab(new TextSnippetsSettingsTab(this.app, this));
		await this.saveSettings();
	}

	async onunload() {
		console.log("Unloading text snippets plugin");

		this.app.workspace.off('keydown', this.handleKeyDown);

		this.registerCodeMirror((editor) => {
			this.settings.isWYSIWYG = (typeof editor.wordAt === 'function');
			// the callback has to be called through another function in order for 'this' to work
			editor.off('keydown', (ed, event) => this.handleKeyDown(ed, event));
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}

	UpdateSplit(newlineSymbol: string) {
		const nlSymb = newlineSymbol.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
		const regex = new RegExp('(?<!' + nlSymb +')\\n');

		this.settings.snippetLookup =
			this.settings.snippets_file
				.split(regex)
				.reduce((obj, [snippetId, replacement]) => {
					return ({...obj, [snippetId]: replacement})
				}, {});
	}

	getSelectedText(editor: Editor) {
		if (!editor.somethingSelected()) {
			const wordBoundaries = this.getWordBoundaries(editor);
			editor.getDoc().setSelection(wordBoundaries.start, wordBoundaries.end);
		}

		return editor.getSelection();
	}

	getWordBoundaries(editor: Editor) {
		const cursor = editor.getCursor();

		let wordStart: number;
		let wordEnd: number;

		if(!this.settings.isWYSIWYG) {
			const word = editor.findWordAt(cursor);
			wordStart = word.anchor.ch;
			wordEnd = word.head.ch;
		} else {
			const word = editor.wordAt(cursor);
			wordStart = word.from.ch;
			wordEnd = word.to.ch;
		}

		return {
			start: {
				line: cursor.line,
				ch: wordStart
			},
			end: {
				line: cursor.line,
				ch: wordEnd
			},
		};
	}

	findSnippet(editor : Editor, cursorOrig: CodeMirror.Position, cursor: CodeMirror.Position) : string {
		let selectedText = this.getSelectedText(editor);
		const wordDelimiters = Array.from(this.settings.wordDelimiters);
		const selectedWoSpaces = selectedText.split(' ').join('');

		if (selectedWoSpaces === '' || wordDelimiters.indexOf(selectedWoSpaces[0]) >= 0 && cursorOrig.ch == cursor.ch) {
			editor.exec('goWordLeft');
			editor.exec('goWordLeft');
			selectedText = this.getSelectedText(editor);
		}

		return this.settings.snippetLookup[selectedText] ?? "";
	}

	calculateCursorStopPos(nStr: string, cursor: CodeMirror.Position): [string, {nlinesCount: number, position: number}] {

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

	insertSnippet(key: string = ''): boolean {
		const editor = this.getEditor();
		const cursorOrig = editor.getCursor();
		const cursorStart = editor.getCursor('from');
		const cursorEnd = editor.getCursor('to');

		const strSnippet = this.findSnippet(editor, cursorOrig, cursorStart);

		//proceed Tab and Spacebar
		if (strSnippet === "" ||
			(key === 'Space' && (cursorOrig.ch !== cursorEnd.ch || cursorOrig.line !== cursorEnd.line)) )  {
			if (!editor.somethingSelected()) {
				editor.getDoc().setSelection(cursorOrig, cursorOrig);
			}
			if (key === 'Space') return false;
			if (strSnippet === "") {
				editor.setCursor(cursorOrig);
				return this.nextStop();
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

			return this.nextStop();
		} else {
			editor.setCursor({
				line: cursorStart.line + endPosition.nlinesCount,
				ch: cursorStart.ch + endPosition.position
			});
		}

		editor.focus();
		return true;
	}

	handleKeyDown (editor: Editor, event: KeyboardEvent): void {
		if ((event.key == 'Tab' && this.settings.useTab) || (event.code == 'Space' && this.settings.useSpace)) {
			this.SnippetOnTrigger(event.code, true);
		}
	}

	SnippetOnTrigger(key: string = '', preventDefault: boolean=false) {
		const editor = this.getEditor();
		const cursorStart = editor.getCursor();

		if (!this.insertSnippet(key)) return;

		this.settings.isWYSIWYG = (typeof editor.wordAt === 'function');

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

		if (cursorStart.ch >=0 && cursorStart.line >= 0) {		//paste text from clipboard
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

	nextStop(): boolean {

		const editor = this.getEditor();

		const search = this.settings.isWYSIWYG
			? editor.searchCursor(this.settings.stopSymbol, editor.getCursor())
			: editor.getSearchCursor(this.settings.stopSymbol, editor.getCursor());

		if (search.findNext()) {
			search.replace("");

			if(!this.settings.isWYSIWYG) {
				editor.setCursor(search.from());
			} else {
				editor.setCursor(search.current().from);
			}
			return true;
		}

		return false;
	}

	getEditor(): Editor {
		const markdownView = this.app.workspace.activeLeaf.view as MarkdownView;
		return markdownView.editor
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
	isWYSIWYG: boolean;
}

const DEFAULT_SETTINGS: TextSnippetsSettings = {
	snippets_file: "snippetLookup : It is an obsidian plugin, that replaces your selected text.",
	snippetLookup : { "snippets": "It is an obsidian plugin, that replaces your selected text."},
	endSymbol: '$end$',
	newlineSymbol: '$nl$',
	stopSymbol: "$tb$",
	pasteSymbol: "$pst$",
	useTab: true,
	useSpace: false,
	wordDelimiters: "$()[]{}<>,.!?;:\'\"\\/",
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
		.setDesc("Type here your snippetLookup in format 'snippet : result', one per line. Empty lines will be ignored. Ctrl+Tab to replace (hotkey can be changed).")
		.setClass("text-snippetLookup-class")
		.addTextArea((text) =>
			text
			.setPlaceholder("before : after")
			.setValue(this.plugin.settings.snippets_file)
			.onChange(async (value) => {
				this.plugin.settings.snippets_file = value;
				this.plugin.UpdateSplit(this.plugin.settings.newlineSymbol);
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl)
		.setName("Cursor end position mark")
		.setDesc("Places the cursor to the mark position after inserting a snippet (default: $end$).\nMark does not appear anywhere within the snippet. Do not use together with Stop Symbol.")
		.setClass("text-snippetLookup-cursor")
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
		.setDesc("Ignores newline after mark, replace it with a newline character after expanding (default: $nl$).\nNecessary to write before every line break in multiline snippetLookup.")
		.setClass("text-snippetLookup-newline")
		.addTextArea((text) =>
			text
			.setPlaceholder("$nl$")
			.setValue(this.plugin.settings.newlineSymbol)
			.onChange(async (value) => {
				if (value == '') {
					value = '$nl$';
				}
				this.plugin.settings.newlineSymbol = value;
				this.plugin.UpdateSplit(value);
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl)
		.setName('Stop Symbol')
		.setDesc('Symbol to jump to when command is called.')
		.setClass("text-snippetLookup-tabstops")
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
		.setClass("text-snippetLookup-tabstops")
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
		.setDesc('Сharacters for specifying the boundary between separate words.')
		.setClass("text-snippetLookup-delimiter")
		.addTextArea((text) => text
			.setPlaceholder('')
			.setValue(this.plugin.settings.wordDelimiters)
			.onChange(async (value) => {
				this.plugin.settings.wordDelimiters = value;
				await this.plugin.saveSettings();
			})
		);

	}
}
