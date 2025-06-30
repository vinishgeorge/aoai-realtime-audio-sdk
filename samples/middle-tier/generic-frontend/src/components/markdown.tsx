import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownProps {
  children: string;
}

const Markdown = ({ children }: MarkdownProps) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table({ node: _node, ...props }) {
          return (
            <table className="border-collapse w-full text-sm" {...props} />
          );
        },
        th({ node: _node, ...props }) {
          return (
            <th
              className="border px-2 py-1 bg-muted font-semibold text-left"
              {...props}
            />
          );
        },
        td({ node: _node, ...props }) {
          return <td className="border px-2 py-1" {...props} />;
        },
        pre({ node: _node, ...props }) {
          return (
            <pre
              className="bg-muted p-2 rounded overflow-x-auto"
              {...props}
            />
          );
        },
        code({ node: _node, inline, className, children, ...props }: {
          node?: unknown;
          inline?: boolean;
          className?: string;
          children?: React.ReactNode;
        } & React.HTMLAttributes<HTMLElement>) {
          if (inline) {
            return (
              <code className="bg-muted px-1 rounded" {...props}>
                {children}
              </code>
            );
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
};

export default Markdown;
