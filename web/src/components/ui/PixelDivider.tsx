import React from 'react';

export const PixelDivider: React.FC<{ className?: string }> = ({ className = 'my-12' }) => {
  return (
    <div className={`w-full relative py-3 border-y border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#0a0e14] overflow-hidden ${className}`}>
      <div
        className="w-full h-3 opacity-60 dark:opacity-40 bg-repeat-x bg-center"
        style={{
          backgroundImage: `url('https://framerusercontent.com/images/YQkeJnGRKgTO0lQ2V724YxSbrSg.png')`,
          backgroundSize: 'contain',
        }}
      />
      <div className="absolute left-4 top-0 bottom-0 w-px bg-[#d1d1d1] dark:bg-[#263140]" />
      <div className="absolute right-4 top-0 bottom-0 w-px bg-[#d1d1d1] dark:bg-[#263140]" />
    </div>
  );
};

export default PixelDivider;
