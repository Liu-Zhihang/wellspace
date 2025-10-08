import React, { useState } from 'react';
import { DatePicker, Button, Row, Col, Tooltip, Space } from 'antd';
import { PlayCircleOutlined, PauseCircleOutlined, BackwardOutlined, ForwardOutlined, FastForwardOutlined, FastBackwardOutlined } from '@ant-design/icons';
import { useShadowMapStore } from '../../store/shadowMapStore';
import dayjs from 'dayjs';

export const TimeControlPanel: React.FC = () => {
  const { currentDate, setCurrentDate } = useShadowMapStore();
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const intervalRef = React.useRef<number | null>(null);

  const handleDateChange = (date: dayjs.Dayjs | null) => {
    if (date) {
      setCurrentDate(date.toDate());
    }
  };

  const togglePlayback = () => {
    if (isPlaying) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      startPlayback();
    }
  };

  const startPlayback = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    intervalRef.current = window.setInterval(() => {
      // ✅ Get fresh state from store each time
      const latestDate = useShadowMapStore.getState().currentDate;
      const newDate = dayjs(latestDate).add(playSpeed, 'hour');
      setCurrentDate(newDate.toDate());
    }, 1000);
  };

  // ✅ Restart playback when speed changes
  React.useEffect(() => {
    if (isPlaying && intervalRef.current) {
      startPlayback();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playSpeed, isPlaying]);

  // ✅ Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  const adjustTime = (hours: number) => {
    const newDate = dayjs(currentDate).add(hours, 'hour');
    setCurrentDate(newDate.toDate());
  };

  const setPresetTime = (hour: number) => {
    const newDate = dayjs(currentDate).hour(hour).minute(0).second(0);
    setCurrentDate(newDate.toDate());
  };

  return (
    <div className="bg-white backdrop-blur-sm rounded-lg p-4 space-y-3 shadow-lg border border-gray-200">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700">Time Control</h3>
        {isPlaying && (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
            Playing {playSpeed}x
          </span>
        )}
      </div>

      <DatePicker
        showTime
        value={dayjs(currentDate)}
        onChange={handleDateChange}
        style={{ width: '100%' }}
        format="YYYY-MM-DD HH:mm"
      />

      <Row gutter={6}>
        <Col span={8}>
          <Button block size="small" onClick={() => setPresetTime(6)}>
            🌅 Sunrise
          </Button>
        </Col>
        <Col span={8}>
          <Button block size="small" onClick={() => setPresetTime(12)}>
            ☀️ Noon
          </Button>
        </Col>
        <Col span={8}>
          <Button block size="small" onClick={() => setPresetTime(18)}>
            🌇 Sunset
          </Button>
        </Col>
      </Row>

      <div className="bg-gray-50/80 rounded-md p-2">
        <Row align="middle" justify="center" gutter={6}>
          <Col>
            <Tooltip title="Back 6h">
              <Button
                size="small"
                icon={<FastBackwardOutlined />}
                onClick={() => adjustTime(-6)}
              />
            </Tooltip>
          </Col>
          <Col>
            <Tooltip title="Back 1h">
              <Button
                size="small"
                icon={<BackwardOutlined />}
                onClick={() => adjustTime(-1)}
              />
            </Tooltip>
          </Col>
          <Col>
            <Tooltip title={isPlaying ? 'Pause' : 'Play'}>
              <Button
                type="primary"
                shape="circle"
                icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                onClick={togglePlayback}
              />
            </Tooltip>
          </Col>
          <Col>
            <Tooltip title="Forward 1h">
              <Button
                size="small"
                icon={<ForwardOutlined />}
                onClick={() => adjustTime(1)}
              />
            </Tooltip>
          </Col>
          <Col>
            <Tooltip title="Forward 6h">
              <Button
                size="small"
                icon={<FastForwardOutlined />}
                onClick={() => adjustTime(6)}
              />
            </Tooltip>
          </Col>
        </Row>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-600">Speed:</span>
        <Space size="small">
          {[1, 2, 4, 6, 12, 24].map((speed) => (
            <Button
              key={speed}
              size="small"
              type={playSpeed === speed ? 'primary' : 'default'}
              onClick={() => setPlaySpeed(speed)}
              style={{ minWidth: '36px' }}
            >
              {speed}x
            </Button>
          ))}
        </Space>
      </div>
    </div>
  );
};
