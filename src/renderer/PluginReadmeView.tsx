import { createContext, useContext, type ReactNode } from 'react';

import type { PluginReadmeBlock, PluginReadmeInline } from '../plugins/plugin-community-readme';
import { Icon } from './Icons';

const ReadmeLinksInteractive = createContext(true);

type PluginReadmeViewProps = {
  readonly blocks: readonly PluginReadmeBlock[];
  readonly empty: string;
  readonly imageLabel: string;
  readonly onOpenUrl: (href: string) => void;
  /** Card and inspector tiles sit inside buttons, so links stay inert there. */
  readonly interactive?: boolean;
};

export function PluginReadmeView({
  blocks,
  empty,
  imageLabel,
  onOpenUrl,
  interactive = true,
}: PluginReadmeViewProps): ReactNode {
  if (blocks.length === 0) {
    return <p className="app-settings-hint">{empty}</p>;
  }
  return (
    <ReadmeLinksInteractive.Provider value={interactive}>
      <div className="plugin-community-readme">
        {blocks.map((block, index) => (
          <ReadmeBlock block={block} imageLabel={imageLabel} key={`${block.type}:${index}`} onOpenUrl={onOpenUrl} />
        ))}
      </div>
    </ReadmeLinksInteractive.Provider>
  );
}

function ReadmeBlock({
  block,
  imageLabel,
  onOpenUrl,
}: {
  readonly block: PluginReadmeBlock;
  readonly imageLabel: string;
  readonly onOpenUrl: (href: string) => void;
}): ReactNode {
  switch (block.type) {
    case 'heading': {
      const children = <ReadmeInlines imageLabel={imageLabel} nodes={block.children} onOpenUrl={onOpenUrl} />;
      if (block.level === 1) return <h4 data-level={block.level}>{children}</h4>;
      if (block.level === 2) return <h5 data-level={block.level}>{children}</h5>;
      return <h6 data-level={block.level}>{children}</h6>;
    }
    case 'table':
      return (
        <div className="plugin-community-readme-table-wrap">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th className={tableAlignClass(block.align[cellIndex]) || undefined} key={cellIndex}>
                    <ReadmeInlines imageLabel={imageLabel} nodes={cell} onOpenUrl={onOpenUrl} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td className={tableAlignClass(block.align[cellIndex]) || undefined} key={cellIndex}>
                      <ReadmeInlines imageLabel={imageLabel} nodes={cell} onOpenUrl={onOpenUrl} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'paragraph':
      return <p><ReadmeInlines imageLabel={imageLabel} nodes={block.children} onOpenUrl={onOpenUrl} /></p>;
    case 'blockquote':
      return <blockquote><ReadmeInlines imageLabel={imageLabel} nodes={block.children} onOpenUrl={onOpenUrl} /></blockquote>;
    case 'list':
      return block.ordered ? (
        <ol>
          {block.items.map((item, index) => (
            <li key={index}><ReadmeInlines imageLabel={imageLabel} nodes={item} onOpenUrl={onOpenUrl} /></li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, index) => (
            <li key={index}><ReadmeInlines imageLabel={imageLabel} nodes={item} onOpenUrl={onOpenUrl} /></li>
          ))}
        </ul>
      );
    case 'code':
      return <pre><code>{block.value}</code></pre>;
    case 'hr':
      return <hr />;
    default:
      return null;
  }
}

function tableAlignClass(align: 'left' | 'center' | 'right' | undefined): string {
  if (align === 'center') return 'is-center';
  if (align === 'right') return 'is-right';
  return '';
}

function ReadmeInlines({
  imageLabel,
  nodes,
  onOpenUrl,
}: {
  readonly imageLabel: string;
  readonly nodes: readonly PluginReadmeInline[];
  readonly onOpenUrl: (href: string) => void;
}): ReactNode {
  const interactive = useContext(ReadmeLinksInteractive);
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return <span key={index}>{node.value}</span>;
      case 'code':
        return <code key={index}>{node.value}</code>;
      case 'strong':
        return <strong key={index}><ReadmeInlines imageLabel={imageLabel} nodes={node.children} onOpenUrl={onOpenUrl} /></strong>;
      case 'em':
        return <em key={index}><ReadmeInlines imageLabel={imageLabel} nodes={node.children} onOpenUrl={onOpenUrl} /></em>;
      case 'link': {
        const children = <ReadmeInlines imageLabel={imageLabel} nodes={node.children} onOpenUrl={onOpenUrl} />;
        if (!interactive) {
          return <span className="plugin-community-readme-link" key={index}>{children}</span>;
        }
        return (
          <button
            className="plugin-community-readme-link"
            key={index}
            onClick={() => onOpenUrl(node.href)}
            type="button"
          >
            {children}
          </button>
        );
      }
      case 'image': {
        const label = node.alt.trim() === '' ? imageLabel : node.alt;
        if (!interactive) {
          return (
            <span className="plugin-community-readme-image" key={index}>
              <Icon name="external-link" size={12} />
              {label}
            </span>
          );
        }
        return (
          <button
            className="plugin-community-readme-image"
            key={index}
            onClick={() => onOpenUrl(node.href)}
            type="button"
          >
            <Icon name="external-link" size={12} />
            {label}
          </button>
        );
      }
      default:
        return null;
    }
  });
}
