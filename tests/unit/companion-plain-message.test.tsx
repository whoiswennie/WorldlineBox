// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MessageContent } from '../../src/renderer/companions/MessageContent';
import { RichMessageContent } from '../../src/renderer/companions/RichMessageContent';
import { plainMessageParagraphs } from '../../src/renderer/companions/plain-message';

it.each(['你好，今天过得怎么样？', '文字中的 12.5 和 a-b 不代表列表。', 'Hello, world! Next: 42.', '第一段\n第二行\n\n另一段', '\n\n前后空行\n\n', '   缩进少于四格\n 单格缩进', '普通的 🐳 表情和 你好\r\n\r\n新段', '', '　中文全角空格保留'])('renders ordinary paragraphs equivalently without requiring the rich renderer: %s', content => {
  expect(plainMessageParagraphs(content)).toBeDefined();
  const markup = (value: string) => value.replace(/ data-message-format="[^"]+"/gu, '').replace(/>\n</gu, '><');
  expect(markup(renderToStaticMarkup(<MessageContent content={content} />))).toBe(markup(renderToStaticMarkup(<RichMessageContent content={content} />)));
});

it.each(['**重要**', '# 标题', '- 项目', '1. 有序列表', '    缩进代码', '\t代码', '标题\n===', '换行  \n下一行', '[来源](https://example.test)', 'https://example.test', 'www.example.test', 'user@example.test', '$x^2$', '~~更正~~', '<b>原始HTML</b>', '&amp;', '\\*转义', '| 表格 |'])('retains full CommonMark/GFM/math handling for syntax: %s', content => {
  expect(plainMessageParagraphs(content)).toBeUndefined();
});
