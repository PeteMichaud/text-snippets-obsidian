export function regexLastIndexOf(strSearch: string, regex: RegExp) {
    //regex has to have global flag for this to work
    let lastIndexOf = -1;
    let nextStop = 0;
    let result;
    while ((result = regex.exec(strSearch)) !== null) {
        lastIndexOf = result.index;
        regex.lastIndex = ++nextStop;
    }
    return lastIndexOf;
}